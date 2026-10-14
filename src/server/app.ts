import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  credentialSchema,
  defaultTheme,
  grantSchema,
  installation,
  jobSchema,
  memberSchema,
  projectInputSchema,
  projectSchema,
  publicJobSchema,
  publicUserSchema,
  roleSchema,
  signInSchema,
  signUpSchema,
  threadInputSchema,
  threadSchema,
  userSchema,
} from '../shared/models.js';
import type { Credential, Project, Thread, User } from '../shared/models.js';
import {
  challenge,
  digest,
  hashPassword,
  HttpError,
  requireValue,
  token,
  verifyPassword,
} from './security.js';
import type { DocumentStore } from './document-store.js';

interface Options {
  store: DocumentStore;
  url: string;
  demoUrl: string;
  allowSignup?: boolean;
  asset?: (file: string) => Promise<Uint8Array>;
  nonce?: string;
}
interface Environment {
  Variables: { principal: Credential; user: User; nonce: string };
}
const now = () => new Date().toISOString();
const messageInput = z.object({ body: z.string().trim().min(1).max(8000) }).strict();
const verifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const grantInput = z
  .object({
    challenge: verifierSchema,
    projectId: z.string().optional(),
    parentOrigin: z.string().optional(),
    kind: z.enum(['embed', 'personal']),
  })
  .strict();
const grantExchange = z.object({ id: z.string(), verifier: verifierSchema }).strict();
const leaseInput = z
  .object({ lease: z.string().min(20), runId: z.string().max(200).optional() })
  .strict();
const completionInput = leaseInput.extend({
  body: z.string().trim().min(1).max(8000),
  status: z.enum(['review', 'failed']),
});

export function createApp(options: Options) {
  const { store, url, demoUrl } = options;
  const app = new Hono<Environment>();

  const limit = (key: string, max: number) => store.limit(key, max);
  const createCredential = async (
    userId: string,
    kind: Credential['kind'],
    projectId: string | null,
    name: string,
    parentOrigin: string | null = null,
  ) => {
    const raw = token();
    const lifetime =
      kind === 'session' || kind === 'embed' ? 8 * 60 * 60_000 : 30 * 24 * 60 * 60_000;
    const record = credentialSchema.parse({
      id: digest(raw),
      userId,
      kind,
      projectId,
      name,
      parentOrigin,
      expiresAt: Date.now() + lifetime,
      createdAt: now(),
    });
    await store.put('credentials', record.id, record);
    return { token: raw, expiresAt: record.expiresAt };
  };
  const authenticate = async (
    header: string | undefined,
    cookie: string | undefined,
  ): Promise<Credential> => {
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : cookie;
    if (!raw) throw new HttpError(401, 'Sign in to the feedback service.');
    const credential = await store.get('credentials', digest(raw), credentialSchema);
    if (!credential || credential.expiresAt < Date.now())
      throw new HttpError(401, 'Your feedback session expired. Sign in again.');
    if (!header && credential.kind !== 'session')
      throw new HttpError(401, 'Invalid browser session.');
    return credential;
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
    const next = threadSchema.parse({
      ...thread,
      messages: [...thread.messages, message],
      revision: thread.revision + 1,
      updatedAt: at,
    });
    const exists = await store.get('threads', thread.id, threadSchema);
    if (!exists) await store.insert('threads', thread.id, next);
    else {
      const updated = await store.mutate('threads', thread.id, threadSchema, (current) =>
        threadSchema.parse({
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
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
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
    console.error('Request failed:', error.message);
    return c.json({ error: 'The service could not complete this request.' }, 500);
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
      if (!c.req.header('content-type')?.startsWith('application/json'))
        throw new HttpError(400, 'Send an application/json request.');
    }
    await next();
  });

  app.get('/api/config', (c) =>
    c.json({ url, demoUrl, allowSignup: options.allowSignup !== false }),
  );
  app.post('/api/auth/signup', async (c) => {
    await limit('signup', 10);
    if (options.allowSignup === false) throw new HttpError(403, 'Registration is closed.');
    const input = signUpSchema.parse(await c.req.json());
    const passwordHash = await hashPassword(input.password);
    const user = userSchema.parse({
      id: randomUUID(),
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      createdAt: now(),
    });
    try {
      await store.insert('users', user.id, user);
    } catch {
      throw new HttpError(409, 'An account with that email already exists.');
    }
    const credential = await createCredential(user.id, 'session', null, 'Browser');
    setCookie(c, 'feedback_session', credential.token, {
      httpOnly: true,
      secure: url.startsWith('https:'),
      sameSite: 'Lax',
      path: '/',
      maxAge: 8 * 3600,
    });
    return c.json({ user: publicUserSchema.parse(user) }, 201);
  });
  app.post('/api/auth/login', async (c) => {
    await limit('login', 30);
    const input = signInSchema.parse(await c.req.json());
    const user = (await store.list('users', userSchema)).find(
      (user) => user.email.toLowerCase() === input.email.toLowerCase(),
    );
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? '00000000000000000000000000000000:'.concat('0'.repeat(128)),
    );
    if (!user || !valid) throw new HttpError(401, 'Email or password is incorrect.');
    const credential = await createCredential(user.id, 'session', null, 'Browser');
    setCookie(c, 'feedback_session', credential.token, {
      httpOnly: true,
      secure: url.startsWith('https:'),
      sameSite: 'Lax',
      path: '/',
      maxAge: 8 * 3600,
    });
    return c.json({ user: publicUserSchema.parse(user) });
  });
  app.post('/api/auth/grants', async (c) => {
    await limit('grants', 60);
    const input = grantInput.parse(await c.req.json());
    if (input.kind === 'embed') {
      const project = requireValue(
        await store.get('projects', input.projectId ?? '', projectSchema),
      );
      if (!project.origins.includes(input.parentOrigin ?? ''))
        throw new HttpError(403, 'Website origin is not registered.');
    }
    const grant = grantSchema.parse({
      id: token(),
      challenge: input.challenge,
      kind: input.kind,
      projectId: input.kind === 'embed' ? input.projectId : null,
      parentOrigin: input.kind === 'embed' ? input.parentOrigin : null,
      userId: null,
      expiresAt: Date.now() + 10 * 60_000,
    });
    await store.put('grants', grant.id, grant);
    return c.json({ id: grant.id, loginUrl: `${url}/auth?grant=${grant.id}` }, 201);
  });
  app.post('/api/auth/exchange', async (c) => {
    await limit('exchange', 120);
    const input = grantExchange.parse(await c.req.json());
    const grant = requireValue(
      await store.get('grants', input.id, grantSchema),
      'Authorization request not found.',
    );
    if (grant.expiresAt < Date.now()) throw new HttpError(410, 'Authorization request expired.');
    if (challenge(input.verifier) !== grant.challenge)
      throw new HttpError(403, 'Invalid authorization proof.');
    if (!grant.userId) return c.json({ pending: true }, 202);
    const user = requireValue(await store.get('users', grant.userId, userSchema));
    if (grant.projectId) {
      const member = await store.get('members', `${grant.projectId}:${user.id}`, memberSchema);
      if (!member) throw new HttpError(403, 'You are not a member of this project.');
    }
    if (!(await store.take('grants', grant.id, grantSchema, grant)))
      throw new HttpError(410, 'Authorization request was already consumed.');
    const credential = await createCredential(
      user.id,
      grant.kind,
      grant.projectId,
      grant.kind === 'personal' ? 'CLI / MCP' : 'Embedded toolbar',
      grant.parentOrigin,
    );
    return c.json({ ...credential, user: publicUserSchema.parse(user) });
  });
  app.get('/api/embed/:id', async (c) => {
    const project = requireValue(await store.get('projects', c.req.param('id'), projectSchema));
    if (!project.origins.includes(c.req.query('origin') ?? ''))
      throw new HttpError(403, 'Website origin is not registered.');
    return c.json({ id: project.id, name: project.name, theme: project.theme });
  });
  app.use('/api/*', async (c, next) => {
    if (
      [
        '/api/config',
        '/api/auth/signup',
        '/api/auth/login',
        '/api/auth/grants',
        '/api/auth/exchange',
      ].includes(c.req.path) ||
      c.req.path.startsWith('/api/embed/')
    )
      return next();
    const cookie = c.req
      .header('Cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('feedback_session='))
      ?.slice('feedback_session='.length);
    const principal = await authenticate(c.req.header('Authorization'), cookie);
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
    c.set('user', requireValue(await store.get('users', principal.userId, userSchema)));
    await limit(`api:${principal.id}`, 240);
    await next();
  });
  app.get('/api/me', (c) =>
    c.json({ user: publicUserSchema.parse(c.get('user')), kind: c.get('principal').kind }),
  );
  app.post('/api/auth/logout', async (c) => {
    await store.delete('credentials', c.get('principal').id);
    deleteCookie(c, 'feedback_session', { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/api/auth/grants/:id', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'session')
      throw new HttpError(403, 'Use your browser session to authorize connections.');
    const grant = requireValue(await store.get('grants', c.req.param('id'), grantSchema));
    if (grant.expiresAt < Date.now()) throw new HttpError(410, 'Authorization request expired.');
    const project = grant.projectId ? await access(principal, grant.projectId) : null;
    return c.json({
      id: grant.id,
      kind: grant.kind,
      projectName: project?.name ?? null,
      parentOrigin: grant.parentOrigin,
      authorized: grant.userId !== null,
    });
  });
  app.post('/api/auth/grants/:id/approve', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'session')
      throw new HttpError(403, 'Use your browser session to authorize connections.');
    const grant = requireValue(await store.get('grants', c.req.param('id'), grantSchema));
    if (grant.expiresAt < Date.now() || grant.userId !== null)
      throw new HttpError(410, 'Authorization request expired or already approved.');
    if (grant.projectId) await access(principal, grant.projectId);
    const next = { ...grant, userId: principal.userId };
    if (!(await store.compare('grants', grant.id, grant, next)))
      throw new HttpError(409, 'Authorization request changed. Try again.');
    return c.json({ ok: true });
  });
  app.get('/api/projects', async (c) => {
    const principal = c.get('principal');
    const memberships = (await store.list('members', memberSchema)).filter(
      (member) => member.userId === principal.userId,
    );
    const projects = (await store.list('projects', projectSchema)).flatMap((project) => {
      const member = memberships.find((member) => member.projectId === project.id);
      return member && (principal.projectId === null || principal.projectId === project.id)
        ? [{ ...project, role: member.role }]
        : [];
    });
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
    const users = await store.list('users', userSchema);
    return c.json({
      members: (await store.list('members', memberSchema))
        .filter((member) => member.projectId === project.id)
        .map((member) => ({
          ...member,
          user: publicUserSchema.parse(
            requireValue(users.find((user) => user.id === member.userId)),
          ),
        })),
    });
  });
  app.post('/api/projects/:id/members', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const input = z
      .object({ email: z.email(), role: roleSchema })
      .strict()
      .parse(await c.req.json());
    const user = requireValue(
      (await store.list('users', userSchema)).find(
        (user) => user.email.toLowerCase() === input.email.toLowerCase(),
      ),
      'Ask this person to create a feedback account first.',
    );
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
      credentials: (await store.list('credentials', credentialSchema))
        .filter((credential) => credential.projectId === project.id && credential.kind === 'agent')
        .map(({ id, name, expiresAt, createdAt }) => ({ id, name, expiresAt, createdAt })),
    });
  });
  app.post('/api/projects/:id/credentials', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const input = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(await c.req.json());
    const credential = await createCredential(c.get('user').id, 'agent', project.id, input.name);
    await store.audit(project.id, c.get('user').id, 'agent.connected', digest(credential.token));
    return c.json(credential, 201);
  });
  app.delete('/api/projects/:id/credentials/:credentialId', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'), true, true);
    const credential = requireValue(
      await store.get('credentials', c.req.param('credentialId'), credentialSchema),
    );
    if (credential.projectId !== project.id || credential.kind !== 'agent')
      throw new HttpError(403, 'Credential belongs to another project.');
    await store.delete('credentials', credential.id);
    await store.audit(project.id, c.get('user').id, 'agent.revoked', credential.id);
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/threads', async (c) => {
    const project = await access(c.get('principal'), c.req.param('id'));
    const cursor = z.coerce.number().int().min(0).default(0).parse(c.req.query('cursor'));
    const events = await store.events(project.id, cursor);
    const threads = (await store.list('threads', threadSchema))
      .filter((thread) => thread.projectId === project.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const jobs = (await store.list('jobs', jobSchema))
      .filter((job) => job.projectId === project.id)
      .map(publicJob);
    return c.json({ threads, jobs, events, cursor: events.at(-1)?.seq ?? cursor });
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
      jobs: (await store.list('jobs', jobSchema))
        .filter((job) => job.threadId === thread.id)
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
      return current;
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
    const previous = (await store.list('jobs', jobSchema)).find(
      (job) => job.projectId === thread.projectId && job.idempotencyKey === input.idempotencyKey,
    );
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
      const saved = (await store.list('jobs', jobSchema)).find(
        (job) => job.projectId === thread.projectId && job.idempotencyKey === input.idempotencyKey,
      );
      if (saved?.threadId === thread.id && saved.revision === input.revision)
        return c.json({ job: publicJob(saved) }, 201);
      throw new HttpError(409, 'This thread already has work in progress.');
    }
    await store.audit(thread.projectId, principal.userId, 'work.requested', job.id);
    return c.json({ job: publicJob(job) }, 201);
  });
  app.get('/api/projects/:id/work', async (c) => {
    await access(c.get('principal'), c.req.param('id'));
    const jobs = (await store.list('jobs', jobSchema))
      .filter((job) => job.projectId === c.req.param('id'))
      .map(publicJob);
    return c.json({ jobs });
  });
  app.post('/api/projects/:id/work/claim', async (c) => {
    const principal = c.get('principal');
    await access(principal, c.req.param('id'), true);
    if (!['agent', 'personal'].includes(principal.kind))
      throw new HttpError(403, 'Use a local connector or agent credential to claim work.');
    const jobs = (await store.list('jobs', jobSchema)).filter(
      (job) => job.projectId === c.req.param('id'),
    );
    if (jobs.some((job) => job.status === 'running')) return c.json({ job: null });
    const job = jobs.find((job) => job.status === 'queued');
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
      const thread = threadSchema.parse({
        ...threadBefore,
        messages: [...threadBefore.messages, message],
        revision: threadBefore.revision + 1,
        updatedAt: at,
      });
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csp-nonce" content="${nonce}"><title>${title}</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/${css}"></head><body><div id="app"></div><script type="module" src="/${entry}"></script></body></html>`;
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
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
