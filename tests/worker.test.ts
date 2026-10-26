import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema, threadSchema, publicJobSchema } from '../src/shared/models.js';
import { deviceConnectionSchema, exchangeConnection } from '../src/shared/oauth.js';

void test(
  'Workers runtime authenticates users and atomically completes work through D1',
  { timeout: 60_000 },
  async () => {
    await mkdir('.data', { recursive: true });
    const state = await mkdtemp('.data/worker-test-');
    const url = 'http://localhost:8789';
    const run = promisify(execFile);
    await run('bunx', [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'feedback-toolbar',
      '--local',
      '--persist-to',
      state,
    ]);
    const worker = spawn(
      'bunx',
      [
        'wrangler',
        'dev',
        '--local',
        '--port',
        '8789',
        '--persist-to',
        state,
        '--var',
        `FEEDBACK_URL:${url}`,
        '--var',
        'DEMO_URL:http://localhost:4311',
        '--var',
        `BETTER_AUTH_SECRET:${randomUUID()}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let diagnostic = '';
    worker.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-4000);
    });
    const ended = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        resolve();
      });
    });
    try {
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`${url}/health`)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* Booting. */
        }
        if (worker.exitCode !== null) break;
        await delay(250);
      }
      assert.ok(ready, `Workers runtime did not start: ${diagnostic}`);
      const password = randomUUID();
      const signup = await fetch(`${url}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({
          name: 'Runtime reviewer',
          email: `${randomUUID()}@example.invalid`,
          password,
        }),
      });
      assert.equal(signup.status, 200);
      const signupUser = z
        .object({ user: z.object({ email: z.string() }) })
        .parse(await signup.json());
      const cookie = signup.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const call = async (path: string, body?: unknown, bearer?: string) => {
        const response = await fetch(`${url}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : { Cookie: cookie }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.ok(response.ok, `Worker ${path} failed (${response.status}): ${diagnostic}`);
        const data: unknown = await response.json();
        return data;
      };
      const project = z.object({ project: projectSchema }).parse(
        await call('/api/projects', {
          name: 'D1 integration',
          origins: ['http://localhost:4311'],
        }),
      ).project;
      const thread = z.object({ thread: threadSchema }).parse(
        await call(`/api/projects/${project.id}/threads`, {
          body: 'Improve the button spacing.',
          context: {
            url: 'http://localhost:4311/?private=value',
            viewport: { width: 1280, height: 800 },
            deployment: 'test',
            anchor: {
              selector: 'button',
              feedbackId: null,
              tag: 'button',
              text: 'Submit',
              label: 'Submit',
              rect: { x: 0, y: 0, width: 100, height: 40 },
            },
          },
        }),
      ).thread;
      await call(`/api/threads/${thread.id}/work`, {
        revision: thread.revision,
        idempotencyKey: randomUUID(),
      });
      const credential = z
        .object({ token: z.string() })
        .parse(await call(`/api/projects/${project.id}/credentials`, { name: 'Runtime agent' }));
      const claimed = z
        .object({ job: publicJobSchema.extend({ snapshot: threadSchema }), lease: z.string() })
        .parse(await call(`/api/projects/${project.id}/work/claim`, {}, credential.token));
      await call(`/api/threads/${thread.id}/messages`, { body: 'Show roads and highways too.' });
      assert.equal(claimed.job.snapshot.messages.length, 1);
      const completed = z
        .object({ job: publicJobSchema, thread: threadSchema })
        .parse(
          await call(
            `/api/work/${claimed.job.id}/complete`,
            { lease: claimed.lease, status: 'review', body: 'Changes ready for review.' },
            credential.token,
          ),
        );
      assert.equal(completed.job.status, 'review');
      assert.equal(completed.thread.unsubmittedMessageCount, 1);
      const previews = z
        .object({ threads: z.array(threadSchema) })
        .parse(await call(`/api/projects/${project.id}/threads`, undefined, credential.token));
      assert.equal(previews.threads[0]?.unsubmittedMessageCount, 1);
      assert.deepEqual(await call(`/api/projects/${project.id}/work/claim`, {}, credential.token), {
        job: null,
      });
      assert.equal(completed.thread.messages.at(-1)?.kind, 'agent');
      assert.equal(completed.thread.context.url, 'http://localhost:4311/');
      const login = await fetch(`${url}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ email: signupUser.user.email, password }),
      });
      assert.equal(login.status, 200);
      const otherCookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(otherCookie);
      const [creation] = await Promise.all([
        fetch(`${url}/api/projects/${project.id}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: otherCookie, Origin: url },
          body: JSON.stringify({ name: 'Concurrent D1 connector' }),
        }),
        call('/api/account/revoke-all', {}),
      ]);
      assert.equal(
        (await fetch(`${url}/api/me`, { headers: { Cookie: otherCookie } })).status,
        401,
      );
      assert.equal((await fetch(`${url}/api/me`, { headers: { Cookie: cookie } })).status, 200);
      if (creation.status === 201) {
        const key = z.object({ token: z.string() }).parse(await creation.json()).token;
        assert.equal(
          (await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${key}` } })).status,
          401,
        );
        assert.equal(
          (
            await fetch(`${url}/api/projects/${project.id}/threads`, {
              headers: { Authorization: `Bearer ${key}` },
            })
          ).status,
          401,
        );
      } else assert.equal(creation.status, 401);
      const recoveredKey = z
        .object({ token: z.string() })
        .parse(
          await call(`/api/projects/${project.id}/credentials`, { name: 'Recovered D1 connector' }),
        );
      assert.equal(
        (
          await fetch(`${url}/api/me`, {
            headers: { Authorization: `Bearer ${recoveredKey.token}` },
          })
        ).status,
        200,
      );
      const setupGrant = deviceConnectionSchema.parse(
        await call('/api/connections/start', {
          kind: 'personal',
          projectId: null,
          parentOrigin: null,
        }),
      );
      await call('/api/connections/approve', { code: setupGrant.user_code, accept: true });
      const setupExchange = await exchangeConnection(url, setupGrant.clientId, {
        deviceCode: setupGrant.device_code,
      });
      assert.ok(setupExchange.connection);
      const setupKey = z
        .object({ token: z.string() })
        .parse(
          await call(
            `/api/projects/${project.id}/credentials`,
            { name: 'Local connector · feedback-toolbar' },
            setupExchange.connection.token,
          ),
        );
      assert.equal(
        (
          await fetch(`${url}/api/me`, {
            headers: { Authorization: `Bearer ${setupKey.token}` },
          })
        ).status,
        200,
      );
      await call(
        `/api/projects/${project.id}/credentials`,
        { name: 'n'.repeat(80) },
        setupExchange.connection.token,
      );
      assert.equal(
        (
          await fetch(`${url}/api/projects/${project.id}/credentials`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${setupExchange.connection.token}`,
            },
            body: JSON.stringify({ name: 'n'.repeat(81) }),
          })
        ).status,
        400,
      );
      const workspace = `${state}/workspace-${'name'.repeat(24)}`;
      const credentials = `${state}/cli-credentials`;
      await mkdir(workspace);
      await mkdir(credentials, { mode: 0o700 });
      await writeFile(
        `${credentials}/credentials.json`,
        JSON.stringify({ [url]: setupExchange.connection }),
        { mode: 0o600 },
      );
      const cliEnvironment = { ...process.env, FEEDBACK_CONFIG_DIR: credentials };
      const setup = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli/main.ts',
          'init',
          '--server',
          url,
          '--project',
          project.id,
          '--workspace',
          workspace,
          '--json',
        ],
        { env: cliEnvironment },
      );
      assert.equal(
        z.object({ agentConnected: z.boolean() }).parse(JSON.parse(setup.stdout)).agentConnected,
        true,
      );
      const names = z
        .object({ credentials: z.array(z.object({ name: z.string() })) })
        .parse(await call(`/api/projects/${project.id}/credentials`));
      assert.ok(
        names.credentials.some(
          ({ name }) => name.startsWith('Local connector · workspace-') && name.length === 80,
        ),
      );
      const device = z
        .object({ clientId: z.string(), device_code: z.string(), user_code: z.string() })
        .parse(
          await call('/api/connections/start', {
            kind: 'personal',
            projectId: null,
            parentOrigin: null,
          }),
        );
      await call('/api/connections/approve', { code: device.user_code, accept: true });
      const [exchange, revocation] = await Promise.all([
        fetch(`${url}/api/auth/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url },
          body: new URLSearchParams({
            client_id: device.clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            resource: `${url}/api`,
          }),
        }),
        call('/api/account/revoke-all', {}),
      ]);
      assert.ok(revocation);
      if (exchange.ok) {
        const issued = z
          .object({ access_token: z.string(), refresh_token: z.string() })
          .parse(await exchange.json());
        assert.equal(
          (
            await fetch(`${url}/api/me`, {
              headers: { Authorization: `Bearer ${issued.access_token}` },
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await fetch(`${url}/api/auth/oauth2/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url },
              body: new URLSearchParams({
                client_id: device.clientId,
                grant_type: 'refresh_token',
                refresh_token: issued.refresh_token,
                resource: `${url}/api`,
              }),
            })
          ).status,
          400,
        );
      } else assert.equal(exchange.status, 400);
      const example = await fetch(`${url}/example`);
      assert.equal(example.status, 200);
      assert.ok((await example.text()).includes(url));
    } finally {
      worker.kill('SIGTERM');
      await ended;
      await rm(state, { recursive: true, force: true });
    }
  },
);
