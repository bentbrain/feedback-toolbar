import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  credentialSchema,
  defaultTheme,
  installation,
  jobSchema,
  memberSchema,
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
      return credentialSchema.parse({
        id: session.session.id,
        userId: session.user.id,
        kind: 'session',
        projectId: null,
        parentOrigin: null,
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
      const principal = requireValue(
        await store.get('credentials', result.key.id, credentialSchema),
      );
      if (principal.userId !== result.key.referenceId || principal.kind !== 'agent')
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
    // First-party client configuration is server-owned; no public registration or redirect URLs.
    const clientId = `feedback_${digest(`${url}:${JSON.stringify(metadata)}`)}`;
    const adapter = (await auth.$context).adapter;
    if (
      !(await adapter.findOne({
        model: 'oauthClient',
        where: [{ field: 'clientId', value: clientId }],
      }))
    ) {
      try {
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
      } catch (error) {
        if (
          !(await adapter.findOne({
            model: 'oauthClient',
            where: [{ field: 'clientId', value: clientId }],
          }))
        )
          throw error;
      }
    }
    const resourceId = `${url}/api`;
    if (
      !(await adapter.findOne({
        model: 'oauthClientResource',
        where: [
          { field: 'clientId', value: clientId },
          { field: 'resourceId', value: resourceId },
        ],
      }))
    ) {
      try {
        await adapter.create({
          model: 'oauthClientResource',
          data: { clientId, resourceId, createdAt: new Date() },
        });
      } catch (error) {
        if (
          !(await adapter.findOne({
            model: 'oauthClientResource',
            where: [
              { field: 'clientId', value: clientId },
              { field: 'resourceId', value: resourceId },
            ],
          }))
        )
          throw error;
      }
    }
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
    const device = await auth.api.deviceVerify({ headers, query: { user_code: code } });
    if (device.resource !== `${url}/api`)
      throw new HttpError(403, 'This request belongs to another account or service.');
    return { metadata, project, device };
  };
  const publicJob = (job: z.infer<typeof jobSchema>) => publicJobSchema.parse(job);
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
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
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
    if (allowed.includes(path) || path === '/callback/github') return auth.handler(c.req.raw);
    return next();
  });
  app.post('/api/connections/start', async (c) => {
    await limit(
      `connections:start:${digest(c.req.header('x-feedback-client-ip') ?? 'unknown')}`,
      120,
    );
    const input = connectionMetadata.parse(await c.req.json());
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
      sql: "SELECT DISTINCT c.clientId,c.name,c.metadata FROM oauthClient c JOIN (SELECT clientId FROM oauthRefreshToken WHERE userId=? AND revoked IS NULL UNION SELECT clientId FROM deviceCode WHERE userId=? AND status='approved') r ON c.clientId=r.clientId LIMIT 200",
      params: [c.get('user').id, c.get('user').id],
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
      { sql: 'DELETE FROM deviceCode WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM oauthAccessToken WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM oauthRefreshToken WHERE userId=?', params: [userId] },
      { sql: 'DELETE FROM apikey WHERE referenceId=?', params: [userId] },
      {
        sql: "DELETE FROM documents WHERE kind='credentials' AND json_extract(data,'$.userId')=?",
        params: [userId],
      },
    ]);
    await auth.api.revokeOtherSessions({ headers: c.req.raw.headers });
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
    await reviewConnection(input.code, c.get('principal'), c.req.raw.headers);
    if (input.accept)
      await auth.api.deviceApprove({ headers: c.req.raw.headers, body: { userCode: input.code } });
    else await auth.api.deviceDeny({ headers: c.req.raw.headers, body: { userCode: input.code } });
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
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const input = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(await c.req.json());
    const key = await auth.api.createApiKey({
      body: {
        userId: c.get('user').id,
        name: input.name,
        expiresIn: 30 * 24 * 60 * 60,
        metadata: { projectId: project.id },
        permissions: { feedback: ['read', 'reply', 'react', 'run'] },
      },
    });
    const record = credentialSchema.parse({
      id: key.id,
      userId: c.get('user').id,
      kind: 'agent',
      projectId: project.id,
      name: input.name,
      parentOrigin: null,
      expiresAt: requireValue(key.expiresAt ?? undefined).getTime(),
      createdAt: key.createdAt.toISOString(),
    });
    await store.insert('credentials', record.id, record);
    await store.audit(project.id, c.get('user').id, 'agent.connected', record.id);
    return c.json({ token: key.key, expiresAt: record.expiresAt }, 201);
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
    if (
      pageUrl &&
      (!project.origins.includes(new URL(pageUrl).origin) ||
        (c.get('principal').parentOrigin &&
          new URL(pageUrl).origin !== c.get('principal').parentOrigin))
    )
      throw new HttpError(403, 'Comment page does not belong to this website.');
    const filters = {
      url: pageUrl ? z.url().max(1500).parse(pageUrl) : undefined,
      search: z.string().max(200).optional().parse(c.req.query('q')),
      status: z.enum(['open', 'resolved']).optional().parse(c.req.query('status')),
    };
    const page = await store.page('threads', project.id, threadSchema, before, filters);
    const threads = page.items;
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
    return c.json({ thread: created }, 201);
  });
  app.get('/api/threads/:id', async (c) => {
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId);
    return c.json({
      thread,
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
    return c.json({ thread: updated }, 201);
  });
  app.post('/api/threads/:id/reactions', async (c) => {
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId, true);
    const input = z
      .object({ messageId: z.string(), emoji: z.enum(['👍', '❤️', '👀', '🎉', '🚀']) })
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
    return c.json({ thread: updated });
  });
  app.patch('/api/threads/:id', async (c) => {
    requireHuman(c.get('principal'));
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(c.get('principal'), thread.projectId, true);
    const input = z
      .object({ status: z.enum(['open', 'resolved']) })
      .strict()
      .parse(await c.req.json());
    const updated = await store.mutate('threads', thread.id, threadSchema, (current) => ({
      ...current,
      status: input.status,
      updatedAt: now(),
      revision: current.revision + 1,
    }));
    await store.audit(thread.projectId, c.get('user').id, 'thread.updated', thread.id);
    return c.json({ thread: updated });
  });
  app.post('/api/threads/:id/work', async (c) => {
    const principal = c.get('principal');
    requireHuman(principal);
    const thread = requireValue(await store.get('threads', c.req.param('id'), threadSchema));
    await access(principal, thread.projectId, true, true);
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
      return c.json({ job: publicJob(previous) }, 201);
    }
    if (thread.revision !== input.revision)
      throw new HttpError(409, 'Feedback changed. Refresh it before sending.');
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
    });
    try {
      const inserted = await store.database.execute({
        sql: "INSERT INTO documents(kind,id,data) SELECT 'jobs',?,? WHERE EXISTS(SELECT 1 FROM documents WHERE kind='threads' AND id=? AND data=?)",
        params: [job.id, JSON.stringify(job), thread.id, JSON.stringify(thread)],
      });
      if (inserted.changes !== 1)
        throw new HttpError(409, 'Feedback changed. Refresh it before sending.');
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
        return c.json({ job: publicJob(saved) }, 201);
      throw new HttpError(409, 'This thread already has work in progress.');
    }
    await store.audit(thread.projectId, principal.userId, 'work.requested', job.id);
    return c.json({ job: publicJob(job) }, 201);
  });
  app.get('/api/projects/:id/work', async (c) => {
    await access(c.get('principal'), c.req.param('id'));
    const jobs = (await projectJobs(c.req.param('id'))).map(publicJob);
    return c.json({ jobs });
  });
  app.post('/api/projects/:id/work/claim', async (c) => {
    const principal = c.get('principal');
    await access(principal, c.req.param('id'), true);
    if (!['agent', 'personal'].includes(principal.kind))
      throw new HttpError(403, 'Use a local connector or agent credential to claim work.');
    await projectJobs(c.req.param('id'));
    const running = await store.query(
      'jobs',
      jobSchema,
      { projectId: c.req.param('id'), status: 'running' },
      1,
    );
    if (running.length) return c.json({ job: null });
    const job = (
      await store.query('jobs', jobSchema, { projectId: c.req.param('id'), status: 'queued' }, 1)
    )[0];
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
      if (!(await store.compare('jobs', job.id, job, claimed))) return c.json({ job: null });
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
        return c.json({ job: publicJob(job), thread });
    }
    throw new HttpError(409, 'Feedback changed concurrently. Retry completion.');
  });
  app.post('/api/work/:id/cancel', async (c) => {
    const job = requireValue(await store.get('jobs', c.req.param('id'), jobSchema));
    await access(c.get('principal'), job.projectId, true, true);
    if (!['queued', 'running'].includes(job.status))
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
    ['/app.js', 'dist/app.js', 'text/javascript'],
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
  app.get('/toolbar', async (c) => {
    const project = requireValue(
      await store.get('projects', c.req.query('project') ?? '', projectSchema),
    );
    const parentOrigin = c.req.query('origin') ?? '';
    if (!project.origins.includes(parentOrigin))
      throw new HttpError(403, 'This website is not registered for the toolbar.');
    c.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${c.get('nonce')}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${parentOrigin}; base-uri 'none'; form-action 'self'`,
    );
    return c.html(html('Feedback toolbar', 'toolbar.js', 'styles.css', c.get('nonce')));
  });
  app.get('/', (c) =>
    c.html(
      html('Feedback · Your website, in conversation', 'app.js', 'styles.css', c.get('nonce')),
    ),
  );
  app.get('/auth', (c) =>
    c.html(html('Sign in · Feedback', 'app.js', 'styles.css', c.get('nonce'))),
  );
  app.get('/health', (c) => c.json({ ok: true, assetVersion: options.assetVersion ?? null }));
  return app;
}
