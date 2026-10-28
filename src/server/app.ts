import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  credentialSchema,
  deliveryInputSchema,
  defaultTheme,
  emojiSchema,
  installation,
  jobSchema,
  memberSchema,
  originSchema,
  projectInputSchema,
  projectSchema,
  publicJobSchema,
  publicUserSchema,
  roleSchema,
  threadInputSchema,
  threadSchema,
} from '../shared/models.js';
import type { Credential, Project, Thread, User } from '../shared/models.js';
import { digest, HttpError, requireValue, token } from './security.js';
import type { DocumentStore } from './document-store.js';
import { createAuthentication, connectionMetadata } from './auth.js';
import { emojiDataResponse } from './emoji-data.js';
import type { AuthenticationOptions } from './auth.js';

interface Options {
  store: DocumentStore;
  url: string;
  demoUrl: string;
  allowSignup?: boolean;
  authentication?: Omit<AuthenticationOptions, 'database' | 'url'>;
  asset?: (file: string) => Promise<Uint8Array>;
  nonce?: string;
  assetVersion?: string | undefined;
  dashboard?: string;
}
interface Environment {
  Variables: { principal: Credential; user: User; nonce: string; requestId: string };
}
const now = () => new Date().toISOString();
function boundedThread(value: unknown): Thread {
  const thread = threadSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(thread)) > 512_000)
    throw new HttpError(
      413,
      'This conversation reached its size limit. Start a focused thread with the current requirements.',
    );
  return thread;
}
const messageInput = z.object({ body: z.string().trim().min(1).max(8000) }).strict();
const leaseInput = z
  .object({ lease: z.string().min(20), runId: z.string().max(200).optional() })
  .strict();
const completionInput = leaseInput.extend({
  body: z.string().trim().min(1).max(8000),
  status: z.enum(['review', 'failed']),
});

export function createApp(options: Options) {
  const { store, url, demoUrl } = options;
  const assetPrefix = options.assetVersion
    ? `/assets/${z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(options.assetVersion)}/`
    : '/';
  const app = new Hono<Environment>();

  const limit = (key: string, max: number) => store.limit(key, max);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  const auth = createAuthentication({
    database: store.authDatabase,
    url,
    allowSignup: options.allowSignup !== false,
    ...(options.authentication ?? { secret: token(), localPassword: local }),
  });
  const findUser = async (id: string) => {
    const user = await (await auth.$context).internalAdapter.findUserById(id);
    if (!user) throw new HttpError(401, 'Your account is no longer available.');
    return publicUserSchema.parse({ ...user, createdAt: user.createdAt.toISOString() });
  };
  const authenticate = async (headers: Headers): Promise<Credential> => {
    const header = headers.get('Authorization');
    if (!header) {
      const session = await auth.api.getSession({ headers });
      if (!session) throw new HttpError(401, 'Sign in to the feedback service.');
      const projectId = headers.get('x-feedback-project');
      const parentOrigin = headers.get('x-feedback-origin');
      if (
        (projectId === null) !== (parentOrigin === null) ||
        (projectId !== null && !/^prj_[a-f0-9]{16}$/.test(projectId))
      )
        throw new HttpError(400, 'Provide a complete toolbar scope.');
      if (parentOrigin !== null) originSchema.parse(parentOrigin);
      return credentialSchema.parse({
        id: session.session.id,
        userId: session.user.id,
        kind: projectId !== null ? 'embed' : 'session',
        projectId,
        parentOrigin,
        name: 'Browser',
        expiresAt: session.session.expiresAt.getTime(),
        createdAt: session.session.createdAt.toISOString(),
      });
    }
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Invalid authorization.');
    const raw = header.slice(7);
    if (raw.startsWith('fta_')) {
      const result = await auth.api.verifyApiKey({ body: { key: raw } });
      if (result.error?.code === 'RATE_LIMITED')
        throw new HttpError(429, 'Too many requests. Try again in a minute.');
      if (!result.valid || !result.key)
        throw new HttpError(401, 'Agent connection expired or was revoked.');
      const principal = await store.get('credentials', result.key.id, credentialSchema);
      if (!principal) throw new HttpError(401, 'Invalid agent connection.');
      if (
        principal.userId !== result.key.referenceId ||
        principal.kind !== 'agent' ||
        principal.generation !== (await store.securityGeneration(principal.userId))
      )
        throw new HttpError(401, 'Invalid agent connection.');
      return principal;
    }
    try {
      const payload = await auth.api.verifyFeedbackToken({ body: { token: raw } });
      const metadata = connectionMetadata.parse(payload);
      const claims = z
        .object({ sub: z.string(), exp: z.number(), iat: z.number(), scope: z.string() })
        .parse(payload);
      const expectedScope = metadata.kind === 'embed' ? 'feedback:project' : 'feedback:account';
      if (!claims.scope.split(' ').includes(expectedScope)) throw new Error('Insufficient scope.');
      return credentialSchema.parse({
        ...metadata,
        id: `oauth:${z.string().parse(payload.client_id)}:${claims.sub}`,
        clientId: z.string().parse(payload.client_id),
        tokenId: z.string().parse(payload.tokenId),
        userId: claims.sub,
        name: metadata.kind === 'embed' ? 'Embedded toolbar' : 'CLI / MCP',
        expiresAt: claims.exp * 1000,
        createdAt: new Date(claims.iat * 1000).toISOString(),
      });
    } catch {
      throw new HttpError(401, 'Your connection expired or was revoked. Sign in again.');
    }
  };
  const connectionClient = async (metadata: z.infer<typeof connectionMetadata>) => {
    // Each connection owns a distinct native client, so disabling it fences in-flight issuance.
    const clientId = `feedback_${randomUUID()}`;
    const adapter = (await auth.$context).adapter;
    await adapter.create({
      model: 'oauthClient',
      data: {
        clientId,
        name: metadata.kind === 'embed' ? 'Website toolbar' : 'Local CLI / MCP',
        tokenEndpointAuthMethod: 'none',
        applicationType: 'native',
        redirectUris: [],
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        scopes: [
          metadata.kind === 'embed' ? 'feedback:project' : 'feedback:account',
          'offline_access',
        ],
        metadata: JSON.stringify(metadata),
        disabled: false,
        skipConsent: false,
        createdAt: new Date(),
      },
    });
    await adapter.create({
      model: 'oauthClientResource',
      data: { clientId, resourceId: `${url}/api`, createdAt: new Date() },
    });
    return clientId;
  };
  const access = async (
    principal: Credential,
    projectId: string,
    write = false,
    owner = false,
  ): Promise<Project> => {
    const project = requireValue(await store.get('projects', projectId, projectSchema));
    if (principal.projectId !== null && principal.projectId !== projectId)
      throw new HttpError(403, 'This credential belongs to another project.');
    const member = await store.get('members', `${projectId}:${principal.userId}`, memberSchema);
    if (
      !member ||
      (write && member.role === 'viewer') ||
      (owner && (member.role !== 'owner' || principal.kind === 'agent'))
    ) {
      throw new HttpError(403, 'You do not have permission for this action.');
    }
    if (principal.kind === 'embed' && !project.origins.includes(principal.parentOrigin ?? ''))
      throw new HttpError(403, 'This website is no longer allowed.');
    return project;
  };
  const requireHuman = (principal: Credential) => {
    if (principal.kind === 'agent')
      throw new HttpError(403, 'Agents cannot start work or change project permissions.');
  };
  const projectJobs = async (projectId: string) => {
    const running = await store.query('jobs', jobSchema, { projectId, status: 'running' }, 1);
    for (const job of running) {
      if ((job.leaseExpiresAt ?? 0) >= Date.now()) continue;
      const failed = jobSchema.parse({
        ...job,
        status: 'failed',
        leaseHash: null,
        result:
          'The runner stopped reporting. Inspect its local changes before requesting another run.',
        updatedAt: now(),
      });
      if (await store.compare('jobs', job.id, job, failed))
        await store.audit(projectId, 'system', 'work.lease-expired', job.id);
    }
    return (await store.query('jobs', jobSchema, { projectId }, 100, 0, true)).reverse();
  };
  const reviewConnection = async (code: string, principal: Credential, headers: Headers) => {
    if (principal.kind !== 'session')
      throw new HttpError(403, 'Authorize connections from your browser.');
    const adapter = (await auth.$context).adapter;
    const record = await adapter.findOne({
      model: 'deviceCode',
      where: [{ field: 'userCode', value: code }],
    });
    const deviceRecord = z.object({ clientId: z.string() }).safeParse(record);
    if (!deviceRecord.success) throw new HttpError(404, 'Connection request not found.');
    const client = await adapter.findOne({
      model: 'oauthClient',
      where: [{ field: 'clientId', value: deviceRecord.data.clientId }],
    });
    const row = z
      .object({ metadata: z.union([z.string(), z.record(z.string(), z.unknown())]) })
      .parse(client);
    const metadata = connectionMetadata.parse(
      typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    );
    const project = metadata.projectId ? await access(principal, metadata.projectId) : null;
    const bound = await store.database.execute({
      sql: 'UPDATE oauthClient SET userId=? WHERE clientId=? AND disabled=0 AND (userId IS NULL OR userId=?)',
      params: [principal.userId, deviceRecord.data.clientId, principal.userId],
    });
    if (bound.changes !== 1)
      throw new HttpError(403, 'This connection was revoked or belongs to another account.');
    const device = await auth.api.deviceVerify({ headers, query: { user_code: code } });
    if (device.resource !== `${url}/api`)
      throw new HttpError(403, 'This request belongs to another account or service.');
    return { metadata, project, device };
  };
  const publicThread = async (thread: Thread) =>
    (await store.withFeedbackState([thread]))[0] ?? thread;
  const publicJob = (job: z.infer<typeof jobSchema>) => {
    const attention =
      job.status === 'queued' && Date.now() - Date.parse(job.createdAt) >= 10 * 60_000
        ? 'unclaimed'
        : job.status === 'failed'
          ? 'interrupted'
          : job.status !== 'cancelled' && job.delivery?.details.remaining.length
            ? 'remaining'
            : job.status === 'review' && job.delivery?.details.stage !== 'verified'
              ? 'unverified'
              : undefined;
    return publicJobSchema.parse({ ...job, ...(attention ? { attention } : {}) });
  };
  const addMessage = async (thread: Thread, principal: Credential, user: User, body: string) => {
    const at = now();
    const message = {
      id: randomUUID(),
      actorId: principal.kind === 'agent' ? principal.id : user.id,
      author: principal.kind === 'agent' ? principal.name : user.name,
      kind: principal.kind === 'agent' ? 'agent' : 'human',
      body,
      createdAt: at,
      reactions: [],
    };
    const next = boundedThread({
      ...thread,
      messages: [...thread.messages, message],
      revision: thread.revision + 1,
      updatedAt: at,
    });
    const exists = await store.get('threads', thread.id, threadSchema);
    if (!exists) await store.insert('threads', thread.id, next);
    else {
      const updated = await store.mutate('threads', thread.id, threadSchema, (current) =>
        boundedThread({
          ...current,
          messages: [...current.messages, message],
          revision: current.revision + 1,
          updatedAt: at,
        }),
      );
      Object.assign(next, updated);
    }
    await store.audit(
      thread.projectId,
      principal.kind === 'agent' ? principal.id : user.id,
      'message.created',
      thread.id,
    );
    return next;
  };
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        },
        400,
      );
    if (error instanceof SyntaxError || error instanceof TypeError)
      return c.json({ error: 'Invalid request.' }, 400);
    console.error(
      JSON.stringify({ event: 'request.failed', path: c.req.path, requestId: c.get('requestId') }),
    );
    return c.json({ error: 'The service could not complete this request.' }, 500);
  });
  const ready = auth.api.getSession({ headers: new Headers() });
  app.use('*', async (_c, next) => {
    await ready;
    await next();
  });
  app.use(
    '*',
    bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ error: 'Request is too large.' }, 413) }),
  );
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).origin !== url)
      throw new HttpError(403, 'Use the configured service URL.');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const nonce = token();
    c.set('nonce', nonce);
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);
    c.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(c.req.method)) {
      const origin = c.req.header('Origin');
      if (origin && origin !== url)
        throw new HttpError(403, 'Cross-origin mutations are not allowed.');
      if (Number(c.req.header('content-length') ?? 0) > 32_768)
        throw new HttpError(413, 'Request is too large.');
      const body = await c.req.raw.clone().text();
      if (Buffer.byteLength(body) > 32_768) throw new HttpError(413, 'Request is too large.');
      if (
        !c.req.path.startsWith('/api/auth/') &&
        !c.req.header('content-type')?.startsWith('application/json')
      )
        throw new HttpError(400, 'Send an application/json request.');
    }
    await next();
  });

  app.get('/api/emoji-data/v1/en/:file', (c) => {
    const response = emojiDataResponse(c.req.param('file'));
    return c.newResponse(response.body, response);
  });
  app.get('/api/config', (c) =>
    c.json({
      url,
      demoUrl,
      allowSignup: local && options.allowSignup !== false,
      github: !local || Boolean(options.authentication?.github),
      localPassword: auth.options.emailAndPassword.enabled,
    }),
  );
  // Only these maintained endpoints are exposed. Registration and key administration remain server-only.
  app.all('/api/auth/*', async (c, next) => {
    const path = c.req.path.slice('/api/auth'.length);
    if (
      c.req.header('x-feedback-project') !== undefined ||
      c.req.header('x-feedback-origin') !== undefined
    )
      throw new HttpError(403, 'Toolbar sessions cannot manage account authentication.');
    const allowed = [
      '/sign-in/social',
      '/get-session',
      '/sign-out',
      '/device/code',
      '/oauth2/token',
      '/oauth2/revoke',
      '/list-sessions',
      '/revoke-session',
      '/revoke-other-sessions',
    ];
    if (local && options.allowSignup !== false) allowed.push('/sign-up/email');
    if (local) allowed.push('/sign-in/email');
    if (path === '/oauth2/token') {
      const body = await c.req.raw.clone().text();
      const clientId = c.req.header('content-type')?.startsWith('application/json')
        ? z.object({ client_id: z.string() }).parse(JSON.parse(body)).client_id
        : new URLSearchParams(body).get('client_id');
      const response = await auth.handler(c.req.raw);
      if (response.ok) {
        // A client remains disabled even if native issuance consumed the device before revocation.
        const client = z
          .object({ disabled: z.number(), userId: z.string().nullable(), metadata: z.string() })
          .safeParse(
            (
              await store.database.execute({
                sql: 'SELECT disabled,userId,metadata FROM oauthClient WHERE clientId=?',
                params: [clientId],
              })
            ).rows[0],
          );
        if (!client.success || client.data.disabled !== 0 || !client.data.userId)
          return c.json(
            {
              error: 'invalid_grant',
              error_description: 'This connection was revoked. Approve a new connection.',
            },
            400,
          );
      }
      if (response.ok) {
        const adapter = (await auth.$context).adapter;
        const client = z
          .object({
            userId: z.string(),
            metadata: z.union([z.string(), z.record(z.string(), z.unknown())]),
          })
          .parse(
            await adapter.findOne({
              model: 'oauthClient',
              where: [{ field: 'clientId', value: clientId }],
            }),
          );
        const metadata = connectionMetadata.parse(
          typeof client.metadata === 'string' ? JSON.parse(client.metadata) : client.metadata,
        );
        if (metadata.kind === 'embed') {
          const session = metadata.browserSessionId
            ? z.object({ userId: z.string(), expiresAt: z.date() }).safeParse(
                await adapter.findOne({
                  model: 'session',
                  where: [{ field: 'id', value: metadata.browserSessionId }],
                }),
              )
            : null;
          if (
            !session?.success ||
            session.data.userId !== client.userId ||
            session.data.expiresAt.getTime() <= Date.now()
          )
            return c.json(
              {
                error: 'invalid_grant',
                error_description: 'The authorizing browser session ended.',
              },
              400,
            );
        }
      }
      return response;
    }
    if (allowed.includes(path) || path === '/callback/github') return auth.handler(c.req.raw);
    return next();
  });
  app.post('/api/connections/start', async (c) => {
    await limit(
      `connections:start:${digest(c.req.header('x-feedback-client-ip') ?? 'unknown')}`,
      120,
    );
    const input = connectionMetadata.parse({
      ...z.record(z.string(), z.unknown()).parse(await c.req.json()),
      browserSessionId: null,
    });
    if (input.kind === 'embed') {
      const project = requireValue(
        await store.get('projects', input.projectId ?? '', projectSchema),
      );
      if (!project.origins.includes(input.parentOrigin ?? ''))
        throw new HttpError(403, 'Website origin is not registered.');
    } else if (input.projectId !== null || input.parentOrigin !== null)
      throw new HttpError(400, 'Invalid account connection.');
    const clientId = await connectionClient(input);
    const device = await auth.api.deviceCode({
      body: {
        client_id: clientId,
        scope: `${input.kind === 'embed' ? 'feedback:project' : 'feedback:account'} offline_access`,
        resource: `${url}/api`,
      },
    });
    return c.json({ ...device, clientId }, 201);
  });
  app.get('/api/embed/:id', async (c) => {
    const project = requireValue(await store.get('projects', c.req.param('id'), projectSchema));
    if (!project.origins.includes(c.req.query('origin') ?? ''))
      throw new HttpError(403, 'Website origin is not registered.');
    return c.json({ id: project.id, name: project.name, theme: project.theme });
  });
  app.use('/api/*', async (c, next) => {
    if (
      ['/api/config', '/api/connections/start'].includes(c.req.path) ||
      c.req.path.startsWith('/api/auth/') ||
      c.req.path.startsWith('/api/embed/')
    )
      return next();
    const principal = await authenticate(c.req.raw.headers);
    if (principal.kind === 'embed') {
      await access(principal, principal.projectId ?? '');
      const allowed =
        c.req.method === 'GET'
          ? /^\/api\/(me|projects|projects\/[^/]+(?:\/threads|\/work)?|threads\/[^/]+)$/.test(
              c.req.path,
            )
          : /^\/api\/(auth\/logout|projects\/[^/]+\/threads|threads\/[^/]+(?:\/messages|\/reactions|\/work)?|work\/[^/]+\/cancel)$/.test(
              c.req.path,
            );
      if (!allowed)
        throw new HttpError(403, 'Toolbar sessions cannot manage accounts or projects.');
    }
    c.set('principal', principal);
    c.set('user', await findUser(principal.userId));
    await limit(`api:${principal.id}`, 240);
    await next();
  });
  app.get('/api/me', (c) =>
    c.json({ user: publicUserSchema.parse(c.get('user')), kind: c.get('principal').kind }),
  );
  app.get('/api/account/connections', async (c) => {
    if (c.get('principal').kind !== 'session')
      throw new HttpError(403, 'Manage connections from your browser.');
    const result = await store.database.execute({
      sql: 'SELECT clientId,name,metadata FROM oauthClient WHERE userId=? AND disabled=0 ORDER BY createdAt DESC LIMIT 200',
      params: [c.get('user').id],
    });
    const connections = result.rows.map((value) => {
      const row = z
        .object({ clientId: z.string(), name: z.string().nullable(), metadata: z.string() })
        .parse(value);
      return {
        clientId: row.clientId,
        name: row.name,
        ...connectionMetadata.parse(JSON.parse(row.metadata)),
      };
    });
    return c.json({ connections });
  });
  app.delete('/api/account/connections/:clientId', async (c) => {
    if (c.get('principal').kind !== 'session')
      throw new HttpError(403, 'Manage connections from your browser.');
    const userId = c.get('user').id;
    const clientId = c.req.param('clientId');
    await store.database.batch([
      {
        sql: 'UPDATE oauthClient SET disabled=1 WHERE userId=? AND clientId=?',
        params: [userId, clientId],
      },
      { sql: 'DELETE FROM deviceCode WHERE userId=? AND clientId=?', params: [userId, clientId] },
      {
        sql: 'DELETE FROM oauthAccessToken WHERE userId=? AND clientId=?',
        params: [userId, clientId],
      },
      {
        sql: 'DELETE FROM oauthRefreshToken WHERE userId=? AND clientId=?',
        params: [userId, clientId],
      },
    ]);
    return c.json({ ok: true });
  });
  app.post('/api/account/revoke-all', async (c) => {
    if (c.get('principal').kind !== 'session')
      throw new HttpError(403, 'Manage connections from your browser.');
    const userId = c.get('user').id;
    await store.database.batch([
      {
        sql: 'INSERT INTO account_security(userId,generation) VALUES(?,1) ON CONFLICT(userId) DO UPDATE SET generation=generation+1',
        params: [userId],
      },
      {
        sql: 'DELETE FROM session WHERE userId=? AND id<>?',
        params: [userId, c.get('principal').id],
      },
      { sql: 'UPDATE oauthClient SET disabled=1 WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM deviceCode WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM oauthAccessToken WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM oauthRefreshToken WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM apikey WHERE referenceId=?', params: [userId] },
      {
        sql: "DELETE FROM documents WHERE kind='credentials' AND json_extract(data,'$.userId')=?",
        params: [userId],
      },
    ]);
    return c.json({ ok: true });
  });
  app.get('/api/connections/approval', async (c) => {
    const code = z.string().min(4).max(20).parse(c.req.query('code'));
    const { metadata, project, device } = await reviewConnection(
      code,
      c.get('principal'),
      c.req.raw.headers,
    );
    return c.json({
      ...metadata,
      id: code,
      projectName: project?.name ?? null,
      authorized: device.status === 'approved',
      denied: device.status === 'denied',
      scopes: device.scope,
    });
  });
  app.post('/api/connections/approve', async (c) => {
    const input = z
      .object({ code: z.string().min(4).max(20), accept: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const { metadata, device } = await reviewConnection(
      input.code,
      c.get('principal'),
      c.req.raw.headers,
    );
    if (input.accept) {
      if (device.status === 'approved') return c.json({ ok: true });
      if (metadata.kind === 'embed') {
        const adapter = (await auth.$context).adapter;
        const record = z.object({ clientId: z.string() }).parse(
          await adapter.findOne({
            model: 'deviceCode',
            where: [{ field: 'userCode', value: input.code }],
          }),
        );
        await adapter.update({
          model: 'oauthClient',
          where: [{ field: 'clientId', value: record.clientId }],
          update: {
            metadata: JSON.stringify({ ...metadata, browserSessionId: c.get('principal').id }),
          },
        });
      }
      await auth.api.deviceApprove({ headers: c.req.raw.headers, body: { userCode: input.code } });
    } else
      await auth.api.deviceDeny({ headers: c.req.raw.headers, body: { userCode: input.code } });
    return c.json({ ok: true });
  });
  app.get('/api/projects', async (c) => {
    const principal = c.get('principal');
    const memberships = await store.query('members', memberSchema, {
      userId: principal.userId,
      ...(principal.projectId ? { projectId: principal.projectId } : {}),
    });
    const projects = await Promise.all(
      memberships.map(async (member) => ({
        ...requireValue(await store.get('projects', member.projectId, projectSchema)),
        role: member.role,
      })),
    );
    return c.json({ projects });
  });
  app.post('/api/projects', async (c) => {
    const principal = c.get('principal');
    if (!['personal', 'session'].includes(principal.kind))
      throw new HttpError(403, 'Use an account credential to create projects.');
    const input = projectInputSchema.parse(await c.req.json());
    const key = c.req.header('Idempotency-Key');
    if (key && key.length > 150) throw new HttpError(400, 'Idempotency key is too long.');
    const keyId = key ? digest(`${principal.userId}:${key}`) : null;
    const previous = keyId
      ? await store.get(
          'project_keys',
          keyId,
          z.object({ projectId: z.string(), fingerprint: z.string() }),
        )
      : undefined;
    if (previous) {
      if (previous.fingerprint !== digest(JSON.stringify(input)))
        throw new HttpError(409, 'Idempotency key was used with different project settings.');
      const project = await access(principal, previous.projectId, false, true);
      return c.json({ project, installation: installation(project, url) }, 201);
    }
    const project = projectSchema.parse({
      id: `prj_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      ...input,
      theme: input.theme ?? defaultTheme,
      createdAt: now(),
      createdBy: principal.userId,
    });
    const writes = [
      store.write('projects', project.id, project, true),
      store.write(
        'members',
        `${project.id}:${principal.userId}`,
        {
          id: `${project.id}:${principal.userId}`,
          projectId: project.id,
          userId: principal.userId,
          role: 'owner',
        },
        true,
      ),
      store.auditStatement(project.id, principal.userId, 'project.created', project.id),
    ];
    if (keyId)
      writes.push(
        store.write(
          'project_keys',
          keyId,
          { projectId: project.id, fingerprint: digest(JSON.stringify(input)) },
          true,
        ),
      );
    try {
      await store.database.batch(writes);
    } catch (failure) {
      if (keyId) {
        const saved = await store.get(
          'project_keys',
          keyId,
          z.object({ projectId: z.string(), fingerprint: z.string() }),
        );
        if (saved?.fingerprint === digest(JSON.stringify(input))) {
          const project = await access(principal, saved.projectId, false, true);
          return c.json({ project, installation: installation(project, url) }, 201);
        }
      }
      throw failure;
    }
    return c.json({ project, installation: installation(project, url) }, 201);
  });
  app.get('/api/projects/:id', async (c) =>
    c.json({ project: await access(c.get('principal'), c.req.param('id')) }),
  );
  app.get('/api/projects/:id/installation', async (c) =>
    c.json(installation(await access(c.get('principal'), c.req.param('id')), url)),
  );
  app.patch('/api/projects/:id', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const input = projectInputSchema.partial().parse(await c.req.json());
    const updated = await store.mutate('projects', project.id, projectSchema, (current) =>
      projectSchema.parse({ ...current, ...input }),
    );
    await store.audit(project.id, c.get('user').id, 'project.updated', project.id);
    return c.json({ project: updated });
  });
  app.get('/api/projects/:id/members', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'));
    const members = await store.query('members', memberSchema, { projectId: project.id });
    return c.json({
      members: await Promise.all(
        members.map(async (member) => ({ ...member, user: await findUser(member.userId) })),
      ),
    });
  });
  app.post('/api/projects/:id/members', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const input = z
      .object({ email: z.email(), role: roleSchema })
      .strict()
      .parse(await c.req.json());
    const found = await (
      await auth.$context
    ).internalAdapter.findUserByEmail(input.email.toLowerCase());
    if (!found) throw new HttpError(404, 'Ask this person to sign into Feedback first.');
    if (!found.user.emailVerified && !local)
      throw new HttpError(403, 'This person needs a verified email address.');
    const user = await findUser(found.user.id);
    const id = `${project.id}:${user.id}`;
    const existing = await store.get('members', id, memberSchema);
    if (existing?.role === 'owner')
      throw new HttpError(409, 'Existing owners cannot be changed here.');
    await store.put('members', id, {
      id,
      projectId: project.id,
      userId: user.id,
      role: input.role,
    });
    await store.audit(project.id, c.get('user').id, 'member.updated', user.id);
    return c.json({ ok: true });
  });
  app.delete('/api/projects/:id/members/:userId', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const id = `${project.id}:${c.req.param('userId')}`;
    const member = requireValue(await store.get('members', id, memberSchema));
    if (member.role === 'owner') throw new HttpError(409, 'Owners cannot be removed here.');
    await store.delete('members', id);
    await store.audit(project.id, c.get('user').id, 'member.removed', member.userId);
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/credentials', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), false, true);
    return c.json({
      credentials: (
        await store.query('credentials', credentialSchema, { projectId: project.id })
      ).map(({ id, name, expiresAt, createdAt }) => ({ id, name, expiresAt, createdAt })),
    });
  });
  app.post('/api/projects/:id/credentials', async (c) => {
    const issuer = c.get('principal');
    const generation = await store.securityGeneration(issuer.userId);
    const project = await access(issuer, c.req.param('id'), true, true);
    const input = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(await c.req.json());
    if (
      issuer.kind !== 'session' &&
      (issuer.kind !== 'personal' || !issuer.clientId || !issuer.tokenId)
    )
      throw new HttpError(403, 'Create agent keys from an authenticated owner connection.');
    const identity =
      issuer.kind === 'session'
        ? {
            sql: 'EXISTS(SELECT 1 FROM session WHERE id=? AND userId=?)',
            params: [issuer.id, issuer.userId],
          }
        : {
            sql: 'EXISTS(SELECT 1 FROM oauthAccessToken t JOIN oauthClient c ON c.clientId=t.clientId WHERE t.id=? AND t.clientId=? AND t.userId=? AND t.revoked IS NULL AND c.disabled=0)',
            params: [requireValue(issuer.tokenId), requireValue(issuer.clientId), issuer.userId],
          };
    const key = await auth.api.createApiKey({
      body: {
        userId: issuer.userId,
        name: input.name,
        expiresIn: 30 * 24 * 60 * 60,
        metadata: { projectId: project.id, generation },
        permissions: { feedback: ['read', 'reply', 'react', 'run'] },
      },
    });
    try {
      const current = await authenticate(c.req.raw.headers);
      if (current.id !== issuer.id)
        throw new HttpError(401, 'The issuing connection changed. Try again.');
      const record = credentialSchema.parse({
        id: key.id,
        userId: issuer.userId,
        kind: 'agent',
        projectId: project.id,
        name: input.name,
        parentOrigin: null,
        generation,
        expiresAt: requireValue(key.expiresAt ?? undefined).getTime(),
        createdAt: key.createdAt.toISOString(),
      });
      // Commit only while both the account generation and native issuing connection remain live.
      const committed = await store.database.execute({
        sql: `INSERT INTO documents(kind,id,data) SELECT 'credentials',?,? WHERE COALESCE((SELECT generation FROM account_security WHERE userId=?),0)=? AND ${identity.sql} AND EXISTS(SELECT 1 FROM documents WHERE kind='members' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.userId')=? AND json_extract(data,'$.role')='owner')`,
        params: [
          record.id,
          JSON.stringify(record),
          issuer.userId,
          generation,
          ...identity.params,
          project.id,
          issuer.userId,
        ],
      });
      if (committed.changes !== 1)
        throw new HttpError(401, 'Account access changed while creating this key. Try again.');
      await store.audit(project.id, issuer.userId, 'agent.connected', record.id);
      return c.json({ token: key.key, expiresAt: record.expiresAt }, 201);
    } catch (error) {
      await (
        await auth.$context
      ).adapter.delete({ model: 'apikey', where: [{ field: 'id', value: key.id }] });
      await store.delete('credentials', key.id);
      throw error;
    }
  });
  app.delete('/api/projects/:id/credentials/:credentialId', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const credential = requireValue(
      await store.get('credentials', c.req.param('credentialId'), credentialSchema),
    );
    if (credential.projectId !== project.id || credential.kind !== 'agent')
      throw new HttpError(403, 'Credential belongs to another project.');
    await (
      await auth.$context
    ).adapter.delete({ model: 'apikey', where: [{ field: 'id', value: credential.id }] });
    await store.delete('credentials', credential.id);
    await store.audit(project.id, c.get('user').id, 'agent.revoked', credential.id);
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/threads', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'));
    const cursor = z.coerce.number().int().min(0).default(0).parse(c.req.query('cursor'));
    const events = await store.events(project.id, cursor);
    const before = z.coerce
      .number()
      .int()
      .min(1)
      .default(Number.MAX_SAFE_INTEGER)
      .parse(c.req.query('before'));
    const pageUrl = c.req.query('url');
    const origin = c.req.query('origin');
    if (origin !== undefined) {
      originSchema.parse(origin);
      if (
        !project.origins.includes(origin) ||
        (c.get('principal').parentOrigin && origin !== c.get('principal').parentOrigin)
      )
        throw new HttpError(403, 'Comment page does not belong to this website.');
    }
    if (
      pageUrl &&
      (!project.origins.includes(new URL(pageUrl).origin) ||
        (c.get('principal').parentOrigin &&
          new URL(pageUrl).origin !== c.get('principal').parentOrigin))
    )
      throw new HttpError(403, 'Comment page does not belong to this website.');
    const ids = c.req.query('ids');
    const filters = {
      ids:
        ids === undefined
          ? undefined
          : z
              .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
              .min(1)
              .max(50)
              .parse(ids.split(',')),
      url: pageUrl ? z.url().max(1500).parse(pageUrl) : undefined,
      origin,
      search: z.string().max(200).optional().parse(c.req.query('q')),
      status: z.enum(['open', 'resolved']).optional().parse(c.req.query('status')),
    };
    const page = await store.page('threads', project.id, threadSchema, before, filters);
    const threads = await store.withFeedbackState(page.items);
    const jobs = (await projectJobs(project.id)).map(publicJob);
    return c.json({
      threads,
      jobs,
      nextBefore: page.nextBefore,
      events,
      cursor: events.at(-1)?.seq ?? cursor,
    });
  });
  app.post('/api/projects/:id/threads', async (c) => {
    const principal = c.get('principal');
    requireHuman(principal);
    const project = await access(principal, c.req.param('id'), true);
    const input = threadInputSchema.parse(await c.req.json());
    const page = new URL(input.context.url);
    if (
      !project.origins.includes(page.origin) ||
      (principal.parentOrigin !== null && principal.parentOrigin !== page.origin)
    )
      throw new HttpError(403, 'Comment page does not belong to this website.');
    page.search = '';
    page.hash = '';
    page.username = '';
    page.password = '';
    const context = { ...input.context, url: page.toString() };
    const thread = threadSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      context,
      status: 'open',
      messages: [],
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    const created = await addMessage(thread, principal, c.get('user'), input.body);
    return c.json({ thread: await publicThread(created) }, 201);
  });
  app.get('/api/threads/:id', async (c) => {
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId);
    return c.json({
      thread: await publicThread(thread),
      jobs: (
        await store.query(
          'jobs',
          jobSchema,
          { projectId: thread.projectId, threadId: thread.id },
          100,
          0,
          true,
        )
      )
        .reverse()
        .map(publicJob),
    });
  });
  app.post('/api/threads/:id/messages', async (c) => {
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId, true);
    const input = messageInput.parse(await c.req.json());
    const updated = await addMessage(thread, c.get('principal'), c.get('user'), input.body);
    return c.json({ thread: await publicThread(updated) }, 201);
  });
  app.post('/api/threads/:id/reactions', async (c) => {
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId, true);
    const input = z
      .object({ messageId: z.string(), emoji: emojiSchema })
      .strict()
      .parse(await c.req.json());
    const principal = c.get('principal');
    const actorId = principal.kind === 'agent' ? principal.id : c.get('user').id;
    const updated = await store.mutate('threads', thread.id, threadSchema, (current) => {
      const message = requireValue(
        current.messages.find((message) => message.id === input.messageId),
      );
      const previous = message.reactions.findIndex(
        (reaction) => reaction.emoji === input.emoji && reaction.actorId === actorId,
      );
      if (previous >= 0) message.reactions.splice(previous, 1);
      else
        message.reactions.push({
          emoji: input.emoji,
          actorId,
          name: principal.kind === 'agent' ? principal.name : c.get('user').name,
        });
      current.updatedAt = now();
      current.revision++;
      return boundedThread(current);
    });
    await store.audit(thread.projectId, actorId, 'reaction.updated', thread.id);
    return c.json({ thread: await publicThread(updated) });
  });
  app.patch('/api/threads/:id', async (c) => {
    requireHuman(c.get('principal'));
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    const project = await access(c.get('principal'), thread.projectId, true);
    const input = z
      .object({ status: z.enum(['open', 'resolved']) })
      .strict()
      .parse(await c.req.json());
    const latest = (await store.query('jobs', jobSchema, { threadId: thread.id }, 1, 0, true))[0];
    if (
      input.status === 'resolved' &&
      latest?.delivery?.details.remaining.length &&
      latest.status !== 'cancelled'
    )
      throw new HttpError(409, 'Remaining work must be completed or cancelled before resolving.');
    const updated = {
      ...thread,
      status: input.status,
      updatedAt: now(),
      revision: thread.revision + 1,
    };
    const guards = [{ kind: 'threads', id: thread.id, before: thread, after: updated }];
    if (
      !(await store.atomicCompare(
        [
          {
            kind: 'projects',
            id: project.id,
            before: project,
            after: { ...project, workVersion: (project.workVersion ?? 0) + 1 },
          },
          ...guards,
          ...(latest ? [{ kind: 'jobs', id: latest.id, before: latest, after: latest }] : []),
        ],
        [],
      ))
    )
      throw new HttpError(409, 'Feedback changed. Refresh before resolving.');
    await store.audit(thread.projectId, c.get('user').id, 'thread.updated', thread.id);
    return c.json({ thread: await publicThread(updated) });
  });
  app.post('/api/threads/:id/work', async (c) => {
    const principal = c.get('principal');
    requireHuman(principal);
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    const project = await access(principal, thread.projectId, true, true);
    const input = z
      .object({ revision: z.number().int(), idempotencyKey: z.string().min(1).max(150) })
      .strict()
      .parse(await c.req.json());
    if (Buffer.byteLength(JSON.stringify(thread)) > 512_000)
      throw new HttpError(
        413,
        'This conversation is too large for one agent request. Start a focused thread with the current requirements.',
      );
    const previous = (
      await store.query(
        'jobs',
        jobSchema,
        { projectId: thread.projectId, idempotencyKey: input.idempotencyKey },
        1,
      )
    )[0];
    if (previous) {
      if (previous.threadId !== thread.id || previous.revision !== input.revision)
        throw new HttpError(409, 'Request key was used for different feedback.');
      return c.json({ job: publicJob(previous), thread: await publicThread(thread) }, 201);
    }
    if (thread.revision !== input.revision)
      throw new HttpError(409, 'Feedback changed. Refresh it before sending.');
    const prior = (await store.query('jobs', jobSchema, { threadId: thread.id }, 1, 0, true))[0];
    const job = jobSchema.parse({
      id: randomUUID(),
      projectId: thread.projectId,
      threadId: thread.id,
      requestedBy: principal.userId,
      revision: thread.revision,
      snapshot: thread,
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
      leaseHash: null,
      claimedBy: null,
      leaseExpiresAt: null,
      runId: null,
      result: null,
      idempotencyKey: input.idempotencyKey,
      ...(prior?.delivery?.details.remaining.length && prior.status !== 'cancelled'
        ? {
            delivery: {
              details: {
                stage: 'planning',
                summary: 'Continuing unfinished work from the previous request.',
                remaining: prior.delivery.details.remaining,
                ...(prior.delivery.details.runUrl ? { runUrl: prior.delivery.details.runUrl } : {}),
                ...(prior.delivery.details.pullRequestUrl
                  ? { pullRequestUrl: prior.delivery.details.pullRequestUrl }
                  : {}),
              },
              reportedAt: now(),
            },
          }
        : {}),
    });
    try {
      const inserted = await store.atomicCompare(
        [
          {
            kind: 'projects',
            id: project.id,
            before: project,
            after: { ...project, workVersion: (project.workVersion ?? 0) + 1 },
          },
          { kind: 'threads', id: thread.id, before: thread, after: thread },
        ],
        [
          store.write('jobs', job.id, job, true),
          store.auditStatement(thread.projectId, principal.userId, 'work.requested', job.id),
        ],
      );
      if (!inserted) throw new Error('Feedback changed while submitting work.');
    } catch (failure) {
      if (failure instanceof HttpError) throw failure;
      const saved = (
        await store.query(
          'jobs',
          jobSchema,
          { projectId: thread.projectId, idempotencyKey: input.idempotencyKey },
          1,
        )
      )[0];
      if (saved?.threadId === thread.id && saved.revision === input.revision)
        return c.json({ job: publicJob(saved), thread: await publicThread(thread) }, 201);
      throw new HttpError(409, 'This thread already has work in progress.');
    }
    return c.json({ job: publicJob(job), thread: await publicThread(thread) }, 201);
  });
  app.get('/api/projects/:id/work', async (c) => {
    await access(c.get('principal'), c.req.param('id'));
    const jobs = (await projectJobs(c.req.param('id'))).map(publicJob);
    return c.json({ jobs });
  });
  app.post('/api/projects/:id/work/claim', async (c) => {
    const input = z
      .object({ requestId: z.string().optional() })
      .strict()
      .parse(await c.req.json());
    const principal = c.get('principal');
    await access(principal, c.req.param('id'), true);
    if (!['agent', 'personal'].includes(principal.kind))
      throw new HttpError(403, 'Use a local connector or agent credential to claim work.');
    await projectJobs(c.req.param('id'));
    const project = requireValue(await store.get('projects', c.req.param('id'), projectSchema));
    const running = await store.query(
      'jobs',
      jobSchema,
      { projectId: c.req.param('id'), status: 'running' },
      1,
    );
    if (running.length) return c.json({ job: null });
    const job = input.requestId
      ? await store.get('jobs', input.requestId, jobSchema)
      : (
          await store.query(
            'jobs',
            jobSchema,
            { projectId: c.req.param('id'), status: 'queued' },
            1,
          )
        )[0];
    if (job && job.projectId !== project.id)
      throw new HttpError(403, 'Request belongs to another project.');
    if (job && job.status !== 'queued') return c.json({ job: null });
    if (!job) return c.json({ job: null });
    const lease = token();
    const claimed = jobSchema.parse({
      ...job,
      leaseHash: digest(lease),
      claimedBy: principal.id,
      leaseExpiresAt: Date.now() + 5 * 60_000,
      status: 'running',
      updatedAt: now(),
    });
    try {
      if (
        !(await store.atomicCompare(
          [
            {
              kind: 'projects',
              id: project.id,
              before: project,
              after: { ...project, workVersion: (project.workVersion ?? 0) + 1 },
            },
            { kind: 'jobs', id: job.id, before: job, after: claimed },
          ],
          [],
        ))
      )
        return c.json({ job: null });
    } catch {
      return c.json({ job: null });
    }
    await store.audit(job.projectId, principal.id, 'work.claimed', job.id);
    return c.json({ job: { ...publicJob(claimed), snapshot: claimed.snapshot }, lease });
  });
  const checkLease = async (jobId: string, principal: Credential, lease: string) => {
    const job = requireValue(await store.get('jobs', jobId, jobSchema));
    await access(principal, job.projectId, true);
    if (job.status !== 'running' || (job.leaseExpiresAt ?? 0) < Date.now())
      throw new HttpError(
        409,
        'Work lease is no longer active. Review this request before retrying.',
      );
    if (job.claimedBy !== principal.id || job.leaseHash !== digest(lease))
      throw new HttpError(403, 'Work lease belongs to another runner.');
    return job;
  };
  app.post('/api/work/:id/resume', async (c) => {
    const input = z
      .object({
        inspection: z.string().trim().min(10).max(2000),
        runId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const principal = c.get('principal');
    const previous = requireValue(await store.get('jobs', c.req.param('id'), jobSchema));
    await access(principal, previous.projectId, true);
    if (!['agent', 'personal'].includes(principal.kind) || previous.claimedBy !== principal.id)
      throw new HttpError(403, 'Only the original runner can resume this request.');
    await projectJobs(previous.projectId);
    const project = requireValue(await store.get('projects', previous.projectId, projectSchema));
    const before = requireValue(await store.get('jobs', previous.id, jobSchema));
    const thread = requireValue(await store.get('threads', before.threadId, threadSchema));
    const latest = (await store.query('jobs', jobSchema, { threadId: thread.id }, 1, 0, true))[0];
    if (before.status !== 'failed' || thread.status !== 'open' || latest?.id !== before.id)
      throw new HttpError(409, 'This request cannot be resumed. Inspect its current state.');
    if (
      (await store.query('jobs', jobSchema, { projectId: project.id, status: 'running' }, 1)).length
    )
      throw new HttpError(409, 'Another request is running for this project.');
    const lease = token();
    const at = now();
    const job = jobSchema.parse({
      ...before,
      status: 'running',
      leaseHash: digest(lease),
      leaseExpiresAt: Date.now() + 5 * 60_000,
      updatedAt: at,
      runId: input.runId ?? before.runId,
      recovery: { inspection: input.inspection, resumedAt: at, previousRunId: before.runId },
    });
    if (
      !(await store.atomicCompare(
        [
          {
            kind: 'projects',
            id: project.id,
            before: project,
            after: { ...project, workVersion: (project.workVersion ?? 0) + 1 },
          },
          { kind: 'threads', id: thread.id, before: thread, after: thread },
          { kind: 'jobs', id: job.id, before, after: job },
        ],
        [store.auditStatement(project.id, principal.id, 'work.resumed', job.id)],
      ))
    )
      throw new HttpError(409, 'Work changed. Inspect before resuming.');
    return c.json({ job: { ...publicJob(job), snapshot: job.snapshot }, lease });
  });
  app.patch('/api/work/:id/delivery', async (c) => {
    const input = z
      .object({ lease: z.string().min(20).optional(), delivery: deliveryInputSchema })
      .strict()
      .parse(await c.req.json());
    const principal = c.get('principal');
    const before = requireValue(await store.get('jobs', c.req.param('id'), jobSchema));
    const project = await access(principal, before.projectId, true);
    if (['agent', 'personal'].includes(principal.kind)) {
      if (before.claimedBy !== principal.id)
        throw new HttpError(403, 'Delivery belongs to another runner.');
      if (before.status === 'running') await checkLease(before.id, principal, input.lease ?? '');
      else if (!['review', 'failed'].includes(before.status))
        throw new HttpError(409, 'This request cannot report delivery.');
    } else await access(principal, before.projectId, true, true);
    const thread = requireValue(await store.get('threads', before.threadId, threadSchema));
    if (input.delivery.stage === 'verified') {
      const latest = (await store.query('jobs', jobSchema, { threadId: thread.id }, 1, 0, true))[0];
      if (latest?.id !== before.id || (await publicThread(thread)).unsubmittedMessageCount)
        throw new HttpError(409, 'Newer feedback remains. Verify the current request first.');
    }
    const at = now();
    const job = jobSchema.parse({
      ...before,
      delivery: { details: input.delivery, reportedAt: at },
      updatedAt: at,
    });
    const updated = { ...thread, updatedAt: at, revision: thread.revision + 1 };
    if (
      !(await store.atomicCompare(
        [
          {
            kind: 'projects',
            id: project.id,
            before: project,
            after: { ...project, workVersion: (project.workVersion ?? 0) + 1 },
          },
          { kind: 'jobs', id: job.id, before, after: job },
          { kind: 'threads', id: thread.id, before: thread, after: updated },
        ],
        [store.auditStatement(job.projectId, principal.id, 'work.delivery-recorded', job.id)],
      ))
    )
      throw new HttpError(409, 'Feedback changed. Refresh before reporting delivery.');
    return c.json({ job: publicJob(job), thread: await publicThread(updated) });
  });
  app.post('/api/work/:id/heartbeat', async (c) => {
    const input = leaseInput.parse(await c.req.json());
    const before = await checkLease(c.req.param('id'), c.get('principal'), input.lease);
    const job = jobSchema.parse({
      ...before,
      runId: input.runId ?? before.runId,
      leaseExpiresAt: Date.now() + 5 * 60_000,
      updatedAt: now(),
    });
    if (!(await store.compare('jobs', job.id, before, job)))
      throw new HttpError(409, 'Work authorization changed. Stop and review.');
    return c.json({ job: publicJob(job) });
  });
  app.post('/api/work/:id/complete', async (c) => {
    const input = completionInput.parse(await c.req.json());
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = await checkLease(c.req.param('id'), c.get('principal'), input.lease);
      const threadBefore = requireValue(await store.get('threads', before.threadId, threadSchema));
      const at = now();
      const principal = c.get('principal');
      const user = c.get('user');
      const job = jobSchema.parse({
        ...before,
        status: input.status,
        result: input.body,
        updatedAt: at,
        runId: input.runId ?? before.runId,
        leaseHash: null,
      });
      const message = {
        id: job.id,
        actorId: principal.kind === 'agent' ? principal.id : user.id,
        author: principal.kind === 'agent' ? principal.name : user.name,
        kind: principal.kind === 'agent' ? 'agent' : 'human',
        body: input.body,
        createdAt: at,
        reactions: [],
      };
      const candidate = threadSchema.parse({
        ...threadBefore,
        messages: [...threadBefore.messages, message],
        revision: threadBefore.revision + 1,
        updatedAt: at,
      });
      const thread =
        Buffer.byteLength(JSON.stringify(candidate)) <= 512_000 ? candidate : threadBefore;
      if (
        await store.atomicCompare(
          [
            { kind: 'jobs', id: job.id, before, after: job },
            { kind: 'threads', id: thread.id, before: threadBefore, after: thread },
          ],
          [store.auditStatement(job.projectId, principal.id, 'work.completed', job.id)],
        )
      )
        return c.json({ job: publicJob(job), thread: await publicThread(thread) });
    }
    throw new HttpError(409, 'Feedback changed concurrently. Retry completion.');
  });
  app.post('/api/work/:id/cancel', async (c) => {
    const job = requireValue(await store.get('jobs', c.req.param('id'), jobSchema));
    await access(c.get('principal'), job.projectId, true, true);
    if (!['queued', 'running'].includes(job.status) && !job.delivery?.details.remaining.length)
      throw new HttpError(409, 'This work is already finished.');
    const cancelled = jobSchema.parse({
      ...job,
      status: 'cancelled',
      leaseHash: null,
      updatedAt: now(),
    });
    if (!(await store.compare('jobs', job.id, job, cancelled)))
      throw new HttpError(409, 'Work changed. Refresh before cancelling.');
    await store.audit(job.projectId, c.get('user').id, 'work.cancelled', job.id);
    return c.json({ job: publicJob(cancelled) });
  });

  const html = (title: string, entry: string, css: string, nonce: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csp-nonce" content="${nonce}"><title>${title}</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="${assetPrefix}${css}"></head><body><div id="app"></div><script type="module" src="${assetPrefix}${entry}"></script></body></html>`;
  for (const [path, file, type] of [
    ['/toolbar.js', 'dist/toolbar.js', 'text/javascript'],
    ['/embed.js', 'dist/embed.js', 'text/javascript'],
    ['/embed-module.js', 'dist/embed-module.js', 'text/javascript'],
    ['/styles.css', 'dist/styles.css', 'text/css'],
    ['/icon.svg', 'assets/icon.svg', 'image/svg+xml'],
  ]) {
    if (!path || !file || !type) continue;
    app.get(path, async (c) => {
      c.header('Content-Type', type);
      if (path.startsWith('/embed')) c.header('Cross-Origin-Resource-Policy', 'cross-origin');
      return options.asset
        ? c.body(new TextDecoder().decode(await options.asset(file)))
        : c.notFound();
    });
  }
  const dashboardAsset = async (c: import('hono').Context<Environment>) => {
    const file = c.req.param('file');
    const version = c.req.param('version');
    if (!file || !/^[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(file) || !options.asset)
      return c.notFound();
    if (
      version &&
      (!/^[a-f0-9]{40}$/.test(version) || !options.dashboard?.includes(`/assets/${version}/`))
    )
      return c.notFound();
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.woff2')
          ? 'font/woff2'
          : 'font/woff';
    try {
      const contents = await options.asset(`dist/dashboard/client/dashboard-assets/${file}`);
      c.header('Content-Type', type);
      return c.body(new Uint8Array(contents));
    } catch (failure) {
      if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT')
        return c.notFound();
      throw failure;
    }
  };
  app.get('/dashboard-assets/:file', dashboardAsset);
  app.get('/assets/:version/dashboard-assets/:file', dashboardAsset);
  app.get('/toolbar', async (c) => {
    const project = requireValue(
      await store.get('projects', c.req.query('project') ?? '', projectSchema),
    );
    const parentOrigin = c.req.query('origin') ?? '';
    if (!project.origins.includes(parentOrigin))
      throw new HttpError(403, 'This website is not registered for the toolbar.');
    c.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${c.get('nonce')}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors ${parentOrigin}; base-uri 'none'; form-action 'self'`,
    );
    return c.html(html('Feedback toolbar', 'toolbar.js', 'styles.css', c.get('nonce')));
  });
  const dashboard = (nonce: string) => options.dashboard?.replaceAll('__FEEDBACK_NONCE__', nonce);
  for (const path of [
    '/',
    '/feedback',
    '/install',
    '/appearance',
    '/people',
    '/agents',
    '/account',
    '/auth',
  ]) {
    app.get(path, (c) => {
      const document = dashboard(c.get('nonce'));
      return document ? c.html(document) : c.notFound();
    });
  }
  app.get('/health', (c) =>
    c.json({ ok: true, assetVersion: options.assetVersion ?? null, serviceOrigin: url }),
  );
  return app;
}
