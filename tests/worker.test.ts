import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectSchema, threadSchema, publicJobSchema } from '../src/shared/models.js';

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
      const signup = await fetch(`${url}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({
          name: 'Runtime reviewer',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        }),
      });
      assert.equal(signup.status, 200, await signup.text());
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
        .object({ job: publicJobSchema, lease: z.string() })
        .parse(await call(`/api/projects/${project.id}/work/claim`, {}, credential.token));
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
      assert.equal(completed.thread.messages.at(-1)?.kind, 'agent');
      assert.equal(completed.thread.context.url, 'http://localhost:4311/');
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
