import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { resolveRunnerRuntime } from '../src/cli/runner-runtime.js';
import { runnerPolicy } from '../src/cli/runner-policy.js';
import { superviseRunner } from '../src/cli/runner-process.js';

void test('runner resolves symlinked installations and grants only executable runtime files', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'feedback-runner-path-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'installation', 'bin');
  const path = join(directory, 'path');
  await mkdir(bin, { recursive: true });
  await mkdir(path);
  for (const name of ['codex', 'codex-code-mode-host', 'codex-linux-sandbox']) {
    await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  await writeFile(join(bin, 'private.key'), 'Must remain outside runtime grants');
  await symlink(join(bin, 'codex'), join(path, 'codex'));
  const runtime = await resolveRunnerRuntime(path);
  assert.equal(runtime.executable, join(bin, 'codex'));
  assert.equal(runtime.readablePaths.length, 3);
  const policy = runnerPolicy(join(directory, 'workspace'), runtime);
  const filesystem = policy.args.find((arg) => arg.startsWith('permissions.feedback.filesystem='));
  assert.ok(filesystem);
  assert.ok(filesystem.includes(`${JSON.stringify(runtime.executable)}="read"`));
  assert.ok(!filesystem.includes(`${JSON.stringify(bin)}="read"`));
  assert.ok(!filesystem.includes('private.key'));
  await assert.rejects(resolveRunnerRuntime(join(directory, 'missing')), /Install Codex/);
});

void test('runner resolves the native executable behind the official package entrypoint', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    t.skip('Executable adapter platform is unsupported.');
    return;
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'feedback-runner-package-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'path');
  const root = join(directory, 'node_modules', '@openai', 'codex');
  const packageRoot = join(
    directory,
    'node_modules',
    '@openai',
    `codex-${process.platform}-${process.arch}`,
  );
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const binary = join(packageRoot, 'vendor', target, 'bin', 'codex');
  await mkdir(dirname(binary), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(path);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  await writeFile(join(packageRoot, 'package.json'), '{}');
  await writeFile(join(root, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o700 });
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await symlink(join(root, 'bin', 'codex.js'), join(path, 'codex'));
  assert.equal((await resolveRunnerRuntime(path)).executable, binary);
  await rm(packageRoot, { recursive: true });
  const bundled = join(root, 'vendor', target, 'bin', 'codex');
  await mkdir(dirname(bundled), { recursive: true });
  await writeFile(bundled, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal((await resolveRunnerRuntime(path)).executable, bundled);
});

void test(
  'installed runner initializes under its actual sandbox with disposable authentication',
  { timeout: 30_000 },
  async (t) => {
    if (process.platform === 'win32') {
      t.skip('Native Windows adapter is unsupported.');
      return;
    }
    let runtime;
    try {
      runtime = await resolveRunnerRuntime();
    } catch (error) {
      if (process.env.CI) throw error;
      t.skip('Install the supported runner to exercise its OS sandbox.');
      return;
    }
    // The CLI refuses helper aliases under /tmp on Linux. Keep disposable auth private.
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const directory = await realpath(await mkdtemp('.data/runner-startup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'workspace');
    const auth = join(directory, 'disposable-auth');
    await mkdir(join(workspace, '.feedback-tmp'), { recursive: true });
    await mkdir(auth, { mode: 0o700 });
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests++;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Disposable startup probe. No real model.' } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const permissions = runnerPolicy(workspace, runtime);
    const args = [
      'exec',
      ...permissions.args,
      '--skip-git-repo-check',
      '--json',
      '-c',
      'model="feedback-startup-probe"',
      '-c',
      'model_provider="feedback_probe"',
      '-c',
      `model_providers.feedback_probe={ name="Disposable probe", base_url="http://127.0.0.1:${address.port}/v1", wire_api="responses", requires_openai_auth=false, request_max_retries=0, stream_max_retries=0 }`,
      'Report startup only.',
    ];
    let diagnostic = '';
    const child = spawn(runtime.executable, args, {
      cwd: workspace,
      env: { ...permissions.environment, HOME: directory, CODEX_HOME: auth },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data: Buffer) => {
      diagnostic += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      diagnostic += data.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => {
          resolve();
        });
      });
    } finally {
      clearTimeout(timer);
    }
    assert.ok(requests > 0, `Runner failed before reaching the disposable provider: ${diagnostic}`);
    assert.ok(!diagnostic.includes('sandbox helper failed'), diagnostic);
  },
);

void test(
  'installed runner cancellation stops a sandboxed tool before its delayed write',
  { timeout: 25_000 },
  async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX runner only.');
      return;
    }
    let runtime;
    try {
      runtime = await resolveRunnerRuntime();
    } catch (error) {
      if (process.env.CI) throw error;
      t.skip('Install the supported runner.');
      return;
    }
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const directory = await realpath(await mkdtemp('.data/runner-cancel-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'workspace');
    const auth = join(directory, 'auth');
    await mkdir(join(workspace, '.feedback-tmp'), { recursive: true });
    await mkdir(auth, { mode: 0o700 });
    const server = createServer((request, response) => {
      request.resume();
      const item = {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'disposable-call',
        arguments: JSON.stringify({
          cmd: 'printf ready > command-started; sleep 4; printf cancelled-write > late-result.txt',
          yield_time_ms: 1000,
          max_output_tokens: 100,
        }),
      };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, value: object) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      };
      emit('response.created', {
        response: { id: 'disposable-response', status: 'in_progress', output: [] },
      });
      emit('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
      emit('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', {
        response: { id: 'disposable-response', status: 'completed', output: [item] },
      });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const permissions = runnerPolicy(workspace, runtime);
    const child = spawn(
      runtime.executable,
      [
        'exec',
        ...permissions.args,
        '--skip-git-repo-check',
        '--json',
        '-c',
        'features.code_mode=false',
        '-c',
        'model="feedback-cancellation-probe"',
        '-c',
        'model_provider="feedback_probe"',
        '-c',
        `model_providers.feedback_probe={name="Disposable",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
        'Run a disposable cancellation probe.',
      ],
      {
        cwd: workspace,
        env: { ...permissions.environment, HOME: directory, CODEX_HOME: auth },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const supervised = superviseRunner(child);
    t.after(() => supervised.terminate());
    let diagnostic = '';
    child.stdout.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-2000);
    });
    child.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-2000);
    });
    let started = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await stat(join(workspace, 'command-started'));
        started = true;
        break;
      } catch {
        /* Tool startup. */
      }
      if (child.exitCode !== null) break;
      await delay(25);
    }
    await supervised.terminate();
    await supervised.exited;
    assert.ok(started, `The disposable tool did not start: ${diagnostic}`);
    await delay(4300);
    await assert.rejects(stat(join(workspace, 'late-result.txt')), { code: 'ENOENT' });
  },
);
