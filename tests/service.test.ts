import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { challenge, token } from '../src/server/security.js';
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
        'Content-Type': 'application/json',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  async function account(name = 'Owner') {
    const email = `${token()}@example.invalid`;
    const response = await call('/api/auth/signup', {
      method: 'POST',
      body: { name, email, password: token() },
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return { email, cookie };
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
  return { store, call, account, project, thread, agent, context };
}

void test('independent accounts, project membership, viewer and agent permissions', async (t) => {
  const f = fixture();
  t.after(() => {
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
void test('authorization grants require proof and approval and can be consumed only once', async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
  });
  const owner = await f.account();
  const project = await f.project(owner.cookie);
  const verifier = token();
  const grant = z.object({ id: z.string() }).parse(
    await (
      await f.call('/api/auth/grants', {
        method: 'POST',
        body: {
          kind: 'embed',
          projectId: project.id,
          parentOrigin: website,
          challenge: challenge(verifier),
        },
      })
    ).json(),
  );
  assert.equal(
    (await f.call('/api/auth/exchange', { method: 'POST', body: { id: grant.id, verifier } }))
      .status,
    202,
  );
  assert.equal(
    (
      await f.call('/api/auth/exchange', {
        method: 'POST',
        body: { id: grant.id, verifier: token() },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/auth/grants/${grant.id}/approve`, {
        method: 'POST',
        cookie: owner.cookie,
        body: {},
      })
    ).status,
    200,
  );
  const exchanges = await Promise.all([
    f.call('/api/auth/exchange', { method: 'POST', body: { id: grant.id, verifier } }),
    f.call('/api/auth/exchange', { method: 'POST', body: { id: grant.id, verifier } }),
  ]);
  assert.deepEqual(exchanges.map((response) => response.status).sort(), [200, 410]);
  const success = exchanges.find((response) => response.status === 200);
  assert.ok(success);
  const auth = z.object({ token: z.string() }).parse(await success.json());
  assert.equal(
    (
      await f.call(`/api/projects/${project.id}`, {
        method: 'PATCH',
        bearer: auth.token,
        body: { name: 'Forbidden' },
      })
    ).status,
    403,
  );
  const another = await f.project(owner.cookie);
  assert.equal(
    (await f.call(`/api/projects/${another.id}/threads`, { bearer: auth.token })).status,
    403,
  );
});
void test('public project IDs and unregistered origins cannot grant comment access', async (t) => {
  const f = fixture();
  t.after(() => {
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
  t.after(() => {
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
  t.after(() => {
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
void test('cancellation, expiry, and revocation fence off stale runners', async (t) => {
  const f = fixture();
  t.after(() => {
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
void test('project setup is idempotent and themes reject executable values', async (t) => {
  const f = fixture();
  t.after(() => {
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
  t.after(() => {
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
