import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { bindingKey } from '../src/cli/client.js';
import { projectSchema, threadSchema, publicJobSchema } from '../src/shared/models.js';

void test(
  'scheduled harness uses real MCP to claim, heartbeat and complete owner-requested work',
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-mcp-'));
    const config = join(directory, 'private-config');
    await mkdir(config, { mode: 0o700 });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new Store(':memory:');
    let app: ReturnType<typeof createApp> | null = null;
    const server = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, env) => {
        const headers = new Headers(request.headers);
        headers.set('x-feedback-client-ip', env.incoming.socket.remoteAddress ?? '127.0.0.1');
        return app
          ? app.fetch(new Request(request, { headers }))
          : new Response(null, { status: 503 });
      },
    });
    t.after(() => {
      server.close();
      store.close();
    });
    await once(server, 'listening');
    const port = z.object({ port: z.number() }).parse(server.address()).port;
    const origin = `http://127.0.0.1:${port}`;
    app = createApp({ store, url: origin, demoUrl: 'http://localhost:4311' });
    const signup = await app.request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-feedback-client-ip': '127.0.0.1' },
      body: JSON.stringify({
        name: 'Scheduled harness reviewer',
        email: `${randomUUID()}@example.invalid`,
        password: randomUUID(),
      }),
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, `Fixture request failed: ${path} (${response.status})`);
      const value: unknown = await response.json();
      return value;
    };
    const project = z.object({ project: projectSchema }).parse(
      await call('/api/projects', {
        name: 'Scheduled website',
        origins: ['http://localhost:4311'],
      }),
    ).project;
    const thread = z.object({ thread: threadSchema }).parse(
      await call(`/api/projects/${project.id}/threads`, {
        body: 'Improve the button spacing.',
        context: {
          url: 'http://localhost:4311/',
          viewport: { width: 1280, height: 800 },
          deployment: null,
          anchor: {
            selector: 'button',
            feedbackId: null,
            tag: 'button',
            text: 'Button',
            label: '',
            rect: { x: 0, y: 0, width: 100, height: 30 },
          },
        },
      }),
    ).thread;
    const credential = z
      .object({ token: z.string(), expiresAt: z.number() })
      .parse(await call(`/api/projects/${project.id}/credentials`, { name: 'Scheduled harness' }));
    await writeFile(
      join(directory, '.feedback-toolbar.json'),
      JSON.stringify({ server: origin, projectId: project.id }),
    );
    await writeFile(
      join(config, 'credentials.json'),
      JSON.stringify({ [bindingKey(origin, project.id, directory)]: credential }),
      { mode: 0o600 },
    );
    const harness = new Client({ name: 'scheduled-fixture', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        resolve('src/cli/main.ts'),
        'mcp',
        '--agent',
        '--workspace',
        directory,
      ],
      cwd: resolve('.'),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: directory,
        FEEDBACK_CONFIG_DIR: config,
      },
      stderr: 'pipe',
    });
    t.after(() => harness.close());
    await harness.connect(transport);
    const tools = await harness.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'claim_work'));
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = z
        .object({
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
          isError: z.boolean().optional(),
        })
        .parse(await harness.callTool({ name, arguments: args }));
      const content = result.content[0];
      assert.ok(content);
      return { error: result.isError ?? false, text: content.text };
    };
    const listed = await tool('list_threads');
    assert.equal(listed.error, false);
    assert.equal(
      z.object({ threads: z.array(threadSchema) }).parse(JSON.parse(listed.text)).threads[0]?.id,
      thread.id,
    );
    const empty = await tool('claim_work');
    assert.equal(z.object({ job: z.null() }).parse(JSON.parse(empty.text)).job, null);
    await call(`/api/threads/${thread.id}/work`, {
      revision: thread.revision,
      idempotencyKey: randomUUID(),
    });
    const claim = await tool('claim_work');
    assert.equal(claim.error, false);
    const claimed = z
      .object({ job: publicJobSchema.extend({ snapshot: threadSchema }), lease: z.string() })
      .parse(JSON.parse(claim.text));
    assert.equal(claimed.job.snapshot.id, thread.id);
    assert.equal(
      (
        await tool('heartbeat_work', {
          requestId: claimed.job.id,
          lease: claimed.lease,
          runId: 'scheduled:fixture',
        })
      ).error,
      false,
    );
    const complete = await tool('complete_work', {
      requestId: claimed.job.id,
      lease: claimed.lease,
      runId: 'scheduled:fixture',
      status: 'review',
      body: 'Proposed spacing change is ready for review.',
    });
    assert.equal(complete.error, false);
    const completed = z
      .object({ job: publicJobSchema, thread: threadSchema })
      .parse(JSON.parse(complete.text));
    assert.equal(completed.job.status, 'review');
    assert.equal(completed.thread.status, 'open');
    assert.equal(completed.thread.messages.at(-1)?.kind, 'agent');
    await call(`/api/threads/${thread.id}/work`, {
      revision: completed.thread.revision,
      idempotencyKey: randomUUID(),
    });
    const next = z
      .object({ job: publicJobSchema, lease: z.string() })
      .parse(JSON.parse((await tool('claim_work')).text));
    await call(`/api/work/${next.job.id}/cancel`, {});
    assert.equal(
      (await tool('heartbeat_work', { requestId: next.job.id, lease: next.lease })).error,
      true,
    );
    assert.equal(
      (
        await tool('complete_work', {
          requestId: next.job.id,
          lease: next.lease,
          status: 'review',
          body: 'Stale result',
        })
      ).error,
      true,
    );
    assert.equal(
      (
        await tool('create_project', {
          name: 'Unauthorized project',
          origins: ['http://localhost:4311'],
          requestKey: randomUUID(),
        })
      ).error,
      true,
    );
  },
);
