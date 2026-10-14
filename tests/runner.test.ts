import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolveRunnerRuntime } from '../src/cli/runner-runtime.js';
import { runnerPolicy } from '../src/cli/runner-policy.js';

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
    const directory = await mkdtemp(join(tmpdir(), 'feedback-runner-startup-'));
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
