import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { token } from '../src/server/security.js';
import {
  credentialSchema,
  jobSchema,
  projectSchema,
  publicJobSchema,
  threadSchema,
} from '../src/shared/models.js';

const service = 'http://localhost:4310';
const website = 'http://localhost:4311';
function fixture() {
  const store = new Store(':memory:');
  const app = createApp({ store, url: service, demoUrl: website });
  const call = async (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      bearer?: string;
      origin?: string;
      key?: string;
    } = {},
  ) =>
    await app.request(`${service}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'x-feedback-client-ip': '127.0.0.1',
        'Content-Type': path.startsWith('/api/auth/oauth2/')
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body === undefined
        ? {}
        : {
            body: path.startsWith('/api/auth/oauth2/')
              ? new URLSearchParams(z.record(z.string(), z.string()).parse(options.body))
              : JSON.stringify(options.body),
          }),
    });
  async function account(name = 'Owner') {
    const email = `${token()}@example.invalid`;
    const password = token();
    const response = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: { name, email, password },
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return { email, cookie, password };
  }
  async function project(cookie: string, key?: string) {
    const response = await call('/api/projects', {
      method: 'POST',
      cookie,
      body: { name: 'Test website', origins: [website] },
      ...(key ? { key } : {}),
    });
    assert.equal(response.status, 201);
    return z.object({ project: projectSchema }).parse(await response.json()).project;
  }
  const context = {
    url: `${website}/page?session=private#token`,
    viewport: { width: 1200, height: 800 },
    deployment: 'commit-a',
    anchor: {
      selector: '[data-feedback-id="hero"]',
      feedbackId: 'hero',
      tag: 'button',
      text: 'Get started',
      label: 'Get started',
      rect: { x: 20, y: 40, width: 120, height: 36 },
    },
  };
  async function thread(cookie: string, projectId: string, body = 'Please increase the spacing.') {
    const response = await call(`/api/projects/${projectId}/threads`, {
      method: 'POST',
      cookie,
      body: { context, body },
    });
    assert.equal(response.status, 201);
    return z.object({ thread: threadSchema }).parse(await response.json()).thread;
  }
  async function agent(cookie: string, projectId: string, name = 'Local agent') {
    const response = await call(`/api/projects/${projectId}/credentials`, {
      method: 'POST',
      cookie,
      body: { name },
    });
    assert.equal(response.status, 201);
    return z.object({ token: z.string() }).parse(await response.json()).token;
  }
  return {
    store,
    call,
    account,
    project,
    thread,
    agent,
    context,
    ready: app.request(`${service}/api/config`),
  };
}

void test('independent accounts, project membership, viewer and agent permissions', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const stranger = await f.account('Stranger');
  const project = await f.project(owner.cookie);
  assert.equal(
    (await f.call(`/api/projects/${project.id}`, { cookie: stranger.cookie })).status,
    403,
  );
  assert.equal((await f.call(`/api/projects/${project.id}`)).status, 401);
  const thread = await f.thread(owner.cookie, project.id);
  await f.call(`/api/projects/${project.id}/members`, {
    method: 'POST',
    cookie: owner.cookie,
    body: { email: stranger.email, role: 'viewer' },
  });
  assert.equal(
    (await f.call(`/api/threads/${thread.id}`, { cookie: stranger.cookie })).status,
    200,
  );
  assert.equal(
    (
      await f.call(`/api/threads/${thread.id}/messages`, {
        method: 'POST',
        cookie: stranger.cookie,
        body: { body: 'A reply' },
      })
    ).status,
    403,
  );
  const agent = await f.agent(owner.cookie, project.id);
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}`, {
        method: 'PATCH',
        bearer: agent,
        body: { name: 'Hijacked' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/threads/${thread.id}/work`, {
        method: 'POST',
        bearer: agent,
        body: { revision: thread.revision, idempotencyKey: 'not-authorized' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/threads/${thread.id}/messages`, {
        method: 'POST',
        bearer: agent,
        body: { body: 'I can discuss feedback.' },
      })
    ).status,
    201,
  );
  const stored = z
    .object({ thread: threadSchema })
    .parse(await (await f.call(`/api/threads/${thread.id}`, { cookie: owner.cookie })).json());
  assert.equal(stored.thread.messages.at(-1)?.kind, 'agent');
  assert.equal(stored.thread.messages.at(-1)?.author, 'Local agent');
});
void test('maintained OAuth device approval is scoped, rotates refresh tokens and revokes access', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const outsider = await f.account('Outsider');
  const project = await f.project(owner.cookie);
  const started = await f.call('/api/connections/start', {
    method: 'POST',
    body: { kind: 'embed', projectId: project.id, parentOrigin: website },
  });
  assert.equal(started.status, 201);
  const device = z
    .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
    .parse(await started.json());
  assert.equal(
    (
      await f.call('/api/connections/approve', {
        method: 'POST',
        cookie: outsider.cookie,
        body: { code: device.user_code, accept: true },
      })
    ).status,
    403,
  );
  const approval = await f.call('/api/connections/approve', {
    method: 'POST',
    cookie: owner.cookie,
    body: { code: device.user_code, accept: true },
  });
  assert.equal(approval.status, 200, await approval.text());
  const body = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: device.clientId,
    device_code: device.device_code,
    resource: `${service}/api`,
  };
  const exchange = await f.call('/api/auth/oauth2/token', { method: 'POST', body });
  const data: unknown = await exchange.json();
  assert.equal(exchange.status, 200, JSON.stringify(data));
  const oauth = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(data);
  assert.equal((await f.call('/api/auth/oauth2/token', { method: 'POST', body })).status, 400);
  const me = await f.call('/api/me', { bearer: oauth.access_token });
  assert.equal(me.status, 200, await me.text());
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}`, {
        method: 'PATCH',
        bearer: oauth.access_token,
        body: { name: 'Forbidden' },
      })
    ).status,
    403,
  );
  const another = await f.project(owner.cookie);
  assert.equal(
    (await f.call(`/api/projects/${another.id}/threads`, { bearer: oauth.access_token })).status,
    403,
  );
  const refresh = await f.call('/api/auth/oauth2/token', {
    method: 'POST',
    body: {
      client_id: device.clientId,
      grant_type: 'refresh_token',
      refresh_token: oauth.refresh_token,
      resource: `${service}/api`,
    },
  });
  const refreshData: unknown = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(refreshData));
  const renewed = z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(refreshData);
  assert.notEqual(renewed.refresh_token, oauth.refresh_token);
  const revoke = await f.call('/api/auth/oauth2/revoke', {
    method: 'POST',
    body: {
      client_id: device.clientId,
      token: renewed.refresh_token,
      token_type_hint: 'refresh_token',
    },
  });
  assert.equal(revoke.status, 200, await revoke.text());
  assert.equal((await f.call('/api/me', { bearer: renewed.access_token })).status, 401);
});
void test('public project IDs and unregistered origins cannot grant comment access', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  assert.equal(
    (
      await f.call(
        `/api/embed/${project.id}?origin=${encodeURIComponent('https://attacker.example')}`,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}/threads`, {
        method: 'POST',
        body: { context: f.context, body: 'No login' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}/threads`, {
        method: 'POST',
        cookie: owner.cookie,
        origin: website,
        body: { context: f.context, body: 'CSRF' },
      })
    ).status,
    403,
  );
  const thread = await f.thread(owner.cookie, project.id);
  assert.equal(thread.context.url, `${website}/page`);
  const injected = await f.call(`/api/projects/${project.id}/threads`, {
    method: 'POST',
    cookie: owner.cookie,
    body: { context: f.context, body: 'Message', author: 'Impersonated' },
  });
  assert.equal(injected.status, 400);
});
void test('concurrent replies and reactions preserve every contributor', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const thread = await f.thread(owner.cookie, project.id);
  const replies = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      f.call(`/api/threads/${thread.id}/messages`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { body: `Reply ${index}` },
      }),
    ),
  );
  assert.ok(replies.every((response) => response.status === 201));
  const result = z
    .object({ thread: threadSchema })
    .parse(await (await f.call(`/api/threads/${thread.id}`, { cookie: owner.cookie })).json());
  assert.equal(result.thread.messages.length, 6);
  assert.equal(new Set(result.thread.messages.map((message) => message.body)).size, 6);
  const messageId = thread.messages[0]?.id;
  assert.ok(messageId);
  const reactions = await Promise.all(
    ['👍', '❤️', '👀'].map((emoji) =>
      f.call(`/api/threads/${thread.id}/reactions`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { messageId, emoji },
      }),
    ),
  );
  assert.ok(reactions.every((response) => response.status === 200));
  const reacted = z
    .object({ thread: threadSchema })
    .parse(await (await f.call(`/api/threads/${thread.id}`, { cookie: owner.cookie })).json());
  assert.equal(reacted.thread.messages[0]?.reactions.length, 3);
});
void test('work is idempotent, revision-bound, and claimed once across competing runners', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const thread = await f.thread(owner.cookie, project.id);
  const a = await f.agent(owner.cookie, project.id, 'Agent A');
  const b = await f.agent(owner.cookie, project.id, 'Agent B');
  const body = { revision: thread.revision, idempotencyKey: 'stable-request' };
  const requests = await Promise.all([
    f.call(`/api/threads/${thread.id}/work`, { method: 'POST', cookie: owner.cookie, body }),
    f.call(`/api/threads/${thread.id}/work`, { method: 'POST', cookie: owner.cookie, body }),
  ]);
  assert.ok(requests.every((response) => response.status === 201));
  const requested = await Promise.all(
    requests.map(async (response) =>
      z.object({ job: publicJobSchema }).parse(await response.json()),
    ),
  );
  assert.equal(requested[0]?.job.id, requested[1]?.job.id);
  const claims = await Promise.all([
    f.call(`/api/projects/${project.id}/work/claim`, { method: 'POST', bearer: a, body: {} }),
    f.call(`/api/projects/${project.id}/work/claim`, { method: 'POST', bearer: b, body: {} }),
  ]);
  const claimSchema = z.object({
    job: publicJobSchema.extend({ snapshot: threadSchema }).nullable(),
    lease: z.string().optional(),
  });
  const parsed = await Promise.all(
    claims.map(async (response) => claimSchema.parse(await response.json())),
  );
  assert.equal(parsed.filter((item) => item.job).length, 1);
  const index = parsed.findIndex((item) => item.job);
  const claim = parsed[index];
  assert.ok(claim?.job && claim.lease);
  assert.equal(claim.job.snapshot.revision, thread.revision);
  const agent = index === 0 ? a : b;
  const other = index === 0 ? b : a;
  assert.equal(
    (
      await f.call(`/api/work/${claim.job.id}/complete`, {
        method: 'POST',
        bearer: other,
        body: { lease: claim.lease, status: 'review', body: 'Wrong runner' },
      })
    ).status,
    403,
  );
  const finished = await f.call(`/api/work/${claim.job.id}/complete`, {
    method: 'POST',
    bearer: agent,
    body: {
      lease: claim.lease,
      status: 'review',
      body: 'Changed spacing. Relevant checks passed. Please review.',
    },
  });
  assert.equal(finished.status, 200);
  const result = z
    .object({ job: publicJobSchema, thread: threadSchema })
    .parse(await finished.json());
  assert.equal(result.job.status, 'review');
  assert.equal(result.thread.status, 'open');
  assert.equal(result.thread.messages.at(-1)?.kind, 'agent');
  assert.equal(result.thread.messages.length, 2);
});
void test('cancellation and revocation fence off stale runners', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const thread = await f.thread(owner.cookie, project.id);
  const agent = await f.agent(owner.cookie, project.id);
  const requested = z.object({ job: publicJobSchema }).parse(
    await (
      await f.call(`/api/threads/${thread.id}/work`, {
        method: 'POST',
        cookie: owner.cookie,
        body: { revision: thread.revision, idempotencyKey: 'cancel-request' },
      })
    ).json(),
  ).job;
  const claim = z.object({ lease: z.string() }).parse(
    await (
      await f.call(`/api/projects/${project.id}/work/claim`, {
        method: 'POST',
        bearer: agent,
        body: {},
      })
    ).json(),
  );
  await f.call(`/api/work/${requested.id}/cancel`, {
    method: 'POST',
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(
    (
      await f.call(`/api/work/${requested.id}/heartbeat`, {
        method: 'POST',
        bearer: agent,
        body: { lease: claim.lease },
      })
    ).status,
    409,
  );
  const credentials = await f.store.list('credentials', credentialSchema);
  const record = credentials.find((item) => item.kind === 'agent');
  assert.ok(record);
  await f.call(`/api/projects/${project.id}/credentials/${record.id}`, {
    method: 'DELETE',
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(
    (await f.call(`/api/projects/${project.id}/threads`, { bearer: agent })).status,
    401,
  );
  const job = await f.store.get('jobs', requested.id, jobSchema);
  assert.ok(job);
  assert.equal(job.status, 'cancelled');
});
void test('oversized streaming bodies stop before authorization or JSON parsing', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const response = await f.call('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name: 'Large request', padding: 'x'.repeat(40_000) },
  });
  assert.equal(response.status, 413);
  assert.equal(
    z
      .object({ count: z.number() })
      .parse(f.store.db.prepare('SELECT COUNT(*) AS count FROM user').get()).count,
    0,
  );
});
void test('project setup is idempotent and themes reject executable values', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const projects = await Promise.all([
    f.project(owner.cookie, 'project-create'),
    f.project(owner.cookie, 'project-create'),
  ]);
  assert.equal(projects[0].id, projects[1].id);
  assert.equal((await f.store.list('projects', projectSchema)).length, 1);
  const project = projects[0];
  assert.ok(project);
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}`, {
        method: 'PATCH',
        cookie: owner.cookie,
        body: { theme: { accent: 'url(javascript:evil)' } },
      })
    ).status,
    400,
  );
  const response = await f.call(`/api/projects/${project.id}`, {
    method: 'PATCH',
    cookie: owner.cookie,
    body: {
      theme: {
        mode: 'dark',
        accent: '#72865d',
        radius: 'round',
        density: 'compact',
        placement: 'bottom-left',
      },
    },
  });
  assert.equal(response.status, 200);
  const embed = await f.call(`/api/embed/${project.id}?origin=${encodeURIComponent(website)}`);
  assert.equal(
    z.object({ theme: z.object({ accent: z.string() }) }).parse(await embed.json()).theme.accent,
    '#72865d',
  );
});
void test('document persistence and transactional compare-and-swap roll back stale writes', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  await f.store.put('test', 'a', { value: 1 });
  await f.store.put('test', 'b', { value: 2 });
  const applied = await f.store.atomicCompare(
    [
      { kind: 'test', id: 'a', before: { value: 1 }, after: { value: 3 } },
      { kind: 'test', id: 'b', before: { value: 0 }, after: { value: 4 } },
    ],
    [],
  );
  assert.equal(applied, false);
  assert.deepEqual(await f.store.get('test', 'a', z.object({ value: z.number() })), { value: 1 });
});

void test('expired runs are fenced off and free the queue without replaying the old task', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const first = await f.thread(owner.cookie, project.id);
  const second = await f.thread(owner.cookie, project.id);
  const agent = await f.agent(owner.cookie, project.id);
  async function requestWork(thread: z.infer<typeof threadSchema>, key: string) {
    const response = await f.call(`/api/threads/${thread.id}/work`, {
      method: 'POST',
      cookie: owner.cookie,
      body: { revision: thread.revision, idempotencyKey: key },
    });
    assert.equal(response.status, 201);
    return z.object({ job: publicJobSchema }).parse(await response.json()).job;
  }
  const requested = await requestWork(first, 'first');
  const claimed = z.object({ job: publicJobSchema, lease: z.string() }).parse(
    await (
      await f.call(`/api/projects/${project.id}/work/claim`, {
        method: 'POST',
        bearer: agent,
        body: {},
      })
    ).json(),
  );
  const running = await f.store.get('jobs', requested.id, jobSchema);
  assert.ok(running);
  await f.store.put('jobs', running.id, { ...running, leaseExpiresAt: Date.now() - 1 });
  const next = await requestWork(second, 'second');
  const nextClaim = await f.call(`/api/projects/${project.id}/work/claim`, {
    method: 'POST',
    bearer: agent,
    body: {},
  });
  assert.equal(nextClaim.status, 200);
  assert.equal(z.object({ job: publicJobSchema }).parse(await nextClaim.json()).job.id, next.id);
  const recovered = await f.store.get('jobs', requested.id, jobSchema);
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered.result ?? '', /Inspect its local changes/);
  assert.equal(
    (
      await f.call(`/api/work/${requested.id}/complete`, {
        method: 'POST',
        bearer: agent,
        body: { lease: claimed.lease, status: 'review', body: 'Stale result' },
      })
    ).status,
    409,
  );
});
void test('tenant-scoped pagination retains every thread without disclosing another project', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const original = await f.thread(owner.cookie, project.id);
  const initialMessage = original.messages[0];
  assert.ok(initialMessage);
  for (let i = 0; i < 52; i++)
    await f.store.insert('threads', `page-${i}`, {
      ...original,
      id: `page-${i}`,
      messages: [{ ...initialMessage, body: 'Recent unrelated feedback' }],
    });
  const other = await f.project(owner.cookie);
  await f.thread(owner.cookie, other.id);
  const response = z
    .object({ threads: z.array(threadSchema), nextBefore: z.number() })
    .parse(
      await (await f.call(`/api/projects/${project.id}/threads`, { cookie: owner.cookie })).json(),
    );
  assert.equal(response.threads.length, 50);
  const remaining = z.object({ threads: z.array(threadSchema), nextBefore: z.null() }).parse(
    await (
      await f.call(`/api/projects/${project.id}/threads?before=${response.nextBefore}`, {
        cookie: owner.cookie,
      })
    ).json(),
  );
  assert.equal(remaining.threads.length, 3);
  assert.equal(
    new Set([...response.threads, ...remaining.threads].map((thread) => thread.id)).size,
    53,
  );
  assert.ok(
    [...response.threads, ...remaining.threads].every((thread) => thread.projectId === project.id),
  );
  const search = z
    .object({ threads: z.array(threadSchema) })
    .parse(
      await (
        await f.call(`/api/projects/${project.id}/threads?q=spacing`, { cookie: owner.cookie })
      ).json(),
    );
  assert.equal(search.threads.length, 1);
  assert.equal(search.threads[0]?.id, original.id);
  const byIds = z.object({ threads: z.array(threadSchema) }).parse(
    await (
      await f.call(`/api/projects/${project.id}/threads?ids=${original.id},page-0&q=spacing`, {
        cookie: owner.cookie,
      })
    ).json(),
  );
  assert.deepEqual(
    byIds.threads.map((thread) => thread.id),
    [original.id],
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${project.id}/threads?ids=${Array.from({ length: 51 }, () => 'id').join(',')}`,
        { cookie: owner.cookie },
      )
    ).status,
    400,
  );
  const unrelated = z.object({ threads: z.array(threadSchema) }).parse(
    await (
      await f.call(`/api/projects/${other.id}/threads?ids=${original.id}`, {
        cookie: owner.cookie,
      })
    ).json(),
  );
  assert.equal(unrelated.threads.length, 0);

  const otherPage = z
    .object({ threads: z.array(threadSchema) })
    .parse(
      await (
        await f.call(
          `/api/projects/${project.id}/threads?url=${encodeURIComponent(website + '/missing')}`,
          { cookie: owner.cookie },
        )
      ).json(),
    );
  assert.equal(otherPage.threads.length, 0);
});

void test('account recovery revokes lost OAuth grants and agent keys while retaining this browser', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const agent = await f.agent(owner.cookie, project.id);
  async function connect() {
    const device = z
      .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
      .parse(
        await (
          await f.call('/api/connections/start', {
            method: 'POST',
            body: { kind: 'personal', projectId: null, parentOrigin: null },
          })
        ).json(),
      );
    assert.equal(
      (
        await f.call('/api/connections/approve', {
          method: 'POST',
          cookie: owner.cookie,
          body: { code: device.user_code, accept: true },
        })
      ).status,
      200,
    );
    const response = await f.call('/api/auth/oauth2/token', {
      method: 'POST',
      body: {
        client_id: device.clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        resource: `${service}/api`,
      },
    });
    assert.equal(response.status, 200);
    return {
      clientId: device.clientId,
      ...z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await response.json()),
    };
  }
  const lost = await connect();
  const connections = await f.call('/api/account/connections', { cookie: owner.cookie });
  assert.equal(
    z
      .object({ connections: z.array(z.object({ clientId: z.string() })) })
      .parse(await connections.json()).connections[0]?.clientId,
    lost.clientId,
  );
  const kept = await connect();
  assert.notEqual(lost.clientId, kept.clientId);
  assert.equal(
    (
      await f.call(`/api/account/connections/${lost.clientId}`, {
        method: 'DELETE',
        cookie: owner.cookie,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal((await f.call('/api/me', { bearer: lost.access_token })).status, 401);
  assert.equal((await f.call('/api/me', { bearer: kept.access_token })).status, 200);
  assert.equal(
    (
      await f.call('/api/auth/oauth2/token', {
        method: 'POST',
        body: {
          client_id: lost.clientId,
          grant_type: 'refresh_token',
          refresh_token: lost.refresh_token,
          resource: `${service}/api`,
        },
      })
    ).status,
    400,
  );
  const next = await connect();
  assert.equal(
    (await f.call('/api/account/revoke-all', { method: 'POST', bearer: agent, body: {} })).status,
    403,
  );
  assert.equal(
    (await f.call('/api/account/revoke-all', { method: 'POST', cookie: owner.cookie, body: {} }))
      .status,
    200,
  );
  assert.equal((await f.call('/api/me', { bearer: next.access_token })).status, 401);
  assert.equal((await f.call('/api/me', { bearer: kept.access_token })).status, 401);
  assert.equal((await f.call('/api/me', { bearer: agent })).status, 401);
  assert.equal((await f.call('/api/me', { cookie: owner.cookie })).status, 200);
});

void test('account recovery invalidates approved device codes before redemption without revoking another user', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const other = await f.account('Other user');
  const prepare = async (cookie: string) => {
    const device = z
      .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
      .parse(
        await (
          await f.call('/api/connections/start', {
            method: 'POST',
            body: { kind: 'personal', projectId: null, parentOrigin: null },
          })
        ).json(),
      );
    assert.equal(
      (
        await f.call('/api/connections/approve', {
          method: 'POST',
          cookie,
          body: { code: device.user_code, accept: true },
        })
      ).status,
      200,
    );
    return device;
  };
  const redeem = (device: { clientId: string; device_code: string }) =>
    f.call('/api/auth/oauth2/token', {
      method: 'POST',
      body: {
        client_id: device.clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        resource: `${service}/api`,
      },
    });
  const lost = await prepare(owner.cookie);
  const unaffected = await prepare(other.cookie);
  assert.equal(
    z
      .object({ connections: z.array(z.object({ clientId: z.string() })) })
      .parse(await (await f.call('/api/account/connections', { cookie: owner.cookie })).json())
      .connections[0]?.clientId,
    lost.clientId,
  );
  assert.equal(
    (
      await f.call(`/api/account/connections/${lost.clientId}`, {
        method: 'DELETE',
        cookie: owner.cookie,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal((await redeem(lost)).status, 400);
  assert.equal((await redeem(unaffected)).status, 200);
  const approved = await prepare(owner.cookie);
  assert.equal(
    (await f.call('/api/account/revoke-all', { method: 'POST', cookie: owner.cookie, body: {} }))
      .status,
    200,
  );
  assert.equal((await redeem(approved)).status, 400);
  assert.equal((await redeem(await prepare(owner.cookie))).status, 200);
});

void test('disconnect and revoke-all fence concurrent device redemption and refresh', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const prepare = async () => {
    const device = z
      .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
      .parse(
        await (
          await f.call('/api/connections/start', {
            method: 'POST',
            body: { kind: 'personal', projectId: null, parentOrigin: null },
          })
        ).json(),
      );
    assert.equal(
      (
        await f.call('/api/connections/approve', {
          method: 'POST',
          cookie: owner.cookie,
          body: { code: device.user_code, accept: true },
        })
      ).status,
      200,
    );
    return device;
  };
  const redeem = (device: { clientId: string; device_code: string }) =>
    f.call('/api/auth/oauth2/token', {
      method: 'POST',
      body: {
        client_id: device.clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        resource: `${service}/api`,
      },
    });
  const tokens = z.object({ access_token: z.string(), refresh_token: z.string() });
  const refresh = (clientId: string, refreshToken: string) =>
    f.call('/api/auth/oauth2/token', {
      method: 'POST',
      body: {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        resource: `${service}/api`,
      },
    });
  for (const all of [false, true]) {
    for (let trial = 0; trial < 6; trial++) {
      const device = await prepare();
      const revoke = () =>
        f.call(all ? '/api/account/revoke-all' : `/api/account/connections/${device.clientId}`, {
          method: all ? 'POST' : 'DELETE',
          cookie: owner.cookie,
          body: {},
        });
      const [exchange, revocation] = await Promise.all([redeem(device), revoke()]);
      assert.equal(revocation.status, 200);
      if (exchange.ok) {
        const issued = tokens.parse(await exchange.json());
        assert.equal((await f.call('/api/me', { bearer: issued.access_token })).status, 401);
        assert.equal((await refresh(device.clientId, issued.refresh_token)).status, 400);
      } else assert.equal(exchange.status, 400);
      const client = await f.store.database.execute({
        sql: 'SELECT disabled FROM oauthClient WHERE clientId=?',
        params: [device.clientId],
      });
      assert.equal(z.object({ disabled: z.number() }).parse(client.rows[0]).disabled, 1);
    }
    const device = await prepare();
    const issued = tokens.parse(await (await redeem(device)).json());
    const [renewal, revoked] = await Promise.all([
      refresh(device.clientId, issued.refresh_token),
      f.call(all ? '/api/account/revoke-all' : `/api/account/connections/${device.clientId}`, {
        method: all ? 'POST' : 'DELETE',
        cookie: owner.cookie,
        body: {},
      }),
    ]);
    assert.equal(revoked.status, 200);
    assert.equal((await f.call('/api/me', { bearer: issued.access_token })).status, 401);
    if (renewal.ok) {
      const next = tokens.parse(await renewal.json());
      assert.equal((await f.call('/api/me', { bearer: next.access_token })).status, 401);
      assert.equal((await refresh(device.clientId, next.refresh_token)).status, 400);
    } else assert.equal(renewal.status, 400);
  }
  const device = await prepare();
  const issued = tokens.parse(await (await redeem(device)).json());
  assert.equal((await f.call('/api/me', { bearer: issued.access_token })).status, 200);
});

void test('account recovery fences concurrent key issuance from another browser and retains the recovery browser', async (t) => {
  for (let trial = 0; trial < 12; trial++) {
    const f = fixture();
    t.after(async () => {
      await f.ready;
      f.store.close();
    });
    const owner = await f.account();
    const project = await f.project(owner.cookie);
    const login = await f.call('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email: owner.email, password: owner.password },
    });
    assert.equal(login.status, 200);
    const otherCookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(otherCookie);
    const [creation, recovery] = await Promise.all([
      f.call(`/api/projects/${project.id}/credentials`, {
        method: 'POST',
        cookie: otherCookie,
        body: { name: 'Concurrent connector' },
      }),
      f.call('/api/account/revoke-all', { method: 'POST', cookie: owner.cookie, body: {} }),
    ]);
    assert.equal(recovery.status, 200);
    assert.equal((await f.call('/api/me', { cookie: otherCookie })).status, 401);
    assert.equal((await f.call('/api/me', { cookie: owner.cookie })).status, 200);
    if (creation.status === 201) {
      const key = z.object({ token: z.string() }).parse(await creation.json()).token;
      assert.equal((await f.call('/api/me', { bearer: key })).status, 401);
      assert.equal(
        (await f.call(`/api/projects/${project.id}/threads`, { bearer: key })).status,
        401,
      );
    } else assert.equal(creation.status, 401);
    assert.equal(
      (
        await f.store.database.execute({
          sql: 'SELECT id FROM apikey WHERE referenceId=?',
          params: [project.createdBy],
        })
      ).rows.length,
      0,
    );
    const fresh = await f.agent(owner.cookie, project.id);
    assert.equal((await f.call('/api/me', { bearer: fresh })).status, 200);
  }
});

void test('agent-key permission generations reject stale records even if native issuance finished after recovery', async (t) => {
  const f = fixture();
  t.after(async () => {
    await f.ready;
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const key = await f.agent(owner.cookie, project.id);
  const userId = project.createdBy;
  const principal = (await f.store.query('credentials', credentialSchema, { userId }))[0];
  assert.ok(principal);
  // Simulate a late native key that escaped the deletion window; its old generation stays fenced.
  await f.store.database.execute({
    sql: 'INSERT INTO account_security(userId,generation) VALUES(?,1) ON CONFLICT(userId) DO UPDATE SET generation=generation+1',
    params: [userId],
  });
  assert.equal((await f.call('/api/me', { bearer: key })).status, 401);
  assert.equal((await f.call(`/api/projects/${project.id}/threads`, { bearer: key })).status, 401);
  assert.equal((await f.store.get('credentials', principal.id, credentialSchema))?.generation, 0);
  const next = await f.agent(owner.cookie, project.id);
  assert.equal((await f.call('/api/me', { bearer: next })).status, 200);
});

void test('native OAuth token revocation prevents concurrent delegation to a fresh agent key', async (t) => {
  for (let trial = 0; trial < 6; trial++) {
    const f = fixture();
    t.after(async () => {
      await f.ready;
      f.store.close();
    });
    const owner = await f.account();
    const project = await f.project(owner.cookie);
    const device = z
      .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
      .parse(
        await (
          await f.call('/api/connections/start', {
            method: 'POST',
            body: { kind: 'personal', projectId: null, parentOrigin: null },
          })
        ).json(),
      );
    await f.call('/api/connections/approve', {
      method: 'POST',
      cookie: owner.cookie,
      body: { code: device.user_code, accept: true },
    });
    const connection = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(
      await (
        await f.call('/api/auth/oauth2/token', {
          method: 'POST',
          body: {
            client_id: device.clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            resource: `${service}/api`,
          },
        })
      ).json(),
    );
    const existing = await f.call(`/api/projects/${project.id}/credentials`, {
      method: 'POST',
      bearer: connection.access_token,
      body: { name: 'Existing CLI connector' },
    });
    assert.equal(existing.status, 201);
    const existingKey = z.object({ token: z.string() }).parse(await existing.json()).token;
    assert.equal((await f.call('/api/me', { bearer: existingKey })).status, 200);
    const [creation, revocation] = await Promise.all([
      f.call(`/api/projects/${project.id}/credentials`, {
        method: 'POST',
        bearer: connection.access_token,
        body: { name: 'Revoked OAuth connector' },
      }),
      f.call('/api/auth/oauth2/revoke', {
        method: 'POST',
        body: {
          client_id: device.clientId,
          token: connection.refresh_token,
          token_type_hint: 'refresh_token',
        },
      }),
    ]);
    assert.equal(revocation.status, 200);
    assert.equal(creation.status, 401);
    assert.equal((await f.call('/api/me', { bearer: existingKey })).status, 200);
    assert.equal(
      (
        await f.store.database.execute({
          sql: 'SELECT id FROM apikey WHERE referenceId=?',
          params: [project.createdBy],
        })
      ).rows.length,
      1,
    );
  }
});
