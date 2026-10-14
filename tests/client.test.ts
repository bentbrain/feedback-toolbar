import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';

void test(
  'independent processes reload rotated credentials under the shared private lock',
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-client-'));
    let refreshes = 0;
    const api = new Hono();
    api.post('/api/auth/oauth2/token', async (c) => {
      const form = new URLSearchParams(await c.req.text());
      if (form.get('refresh_token') !== 'fixture-refresh-original' || refreshes)
        return c.json({ error: 'invalid_grant' }, 400);
      refreshes++;
      return c.json({
        access_token: 'fixture-access-replacement',
        refresh_token: 'fixture-refresh-replacement',
        expires_in: 900,
      });
    });
    api.get('/api/me', (c) =>
      c.req.header('Authorization') === 'Bearer fixture-access-replacement'
        ? c.json({ ok: true })
        : c.json({ error: 'Invalid token' }, 401),
    );
    const server = serve({ fetch: api.fetch, port: 0, hostname: '127.0.0.1' });
    t.after(() => {
      server.close();
    });
    await once(server, 'listening');
    const port = z.object({ port: z.number() }).parse(server.address()).port;
    const origin = `http://127.0.0.1:${port}`;
    await writeFile(
      join(directory, 'credentials.json'),
      JSON.stringify({
        [origin]: {
          token: 'fixture-access-original',
          refreshToken: 'fixture-refresh-original',
          clientId: 'fixture-cli',
          expiresAt: Date.now() + 120_000,
        },
      }),
      { mode: 0o600 },
    );
    const childScript = `import { client } from './src/cli/client.ts';
const clock = Date.now;
const connection = await client({ server: ${JSON.stringify(origin)}, workspace: ${JSON.stringify(directory)} });
process.stdout.write('ready\\n');
process.stdin.once('data', async () => {
  Date.now = () => clock() + 90_000;
  try { await connection.api('/api/me'); process.stdout.write('ok\\n'); }
  catch { process.exitCode = 1; }
  process.stdin.destroy();
});`;
    const children: ReturnType<typeof spawn>[] = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
      server.close();
      await rm(directory, { recursive: true, force: true });
    });
    async function start() {
      const environment: NodeJS.ProcessEnv = { ...process.env, FEEDBACK_CONFIG_DIR: directory };
      delete environment.FEEDBACK_TOKEN;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript],
        { cwd: resolve('.'), env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.push(child);
      const stdout = child.stdout;
      const stdin = child.stdin;
      assert.ok(stdout);
      assert.ok(stdin);
      let output = '';
      stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString();
      });
      const ready = await once(stdout, 'data');
      assert.equal(String(ready[0]), 'ready\n');
      return { child, stdin, output: () => output };
    }
    const first = await start();
    const second = await start();
    for (const runner of [first, second]) {
      const ended = once(runner.child, 'exit');
      runner.stdin.write('refresh\n');
      const result = await ended;
      assert.equal(result[0], 0);
      assert.match(runner.output(), /ok/);
    }
    assert.equal(refreshes, 1);
    assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  },
);
