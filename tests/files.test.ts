import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegularFile, replaceFile } from '../src/shared/files.js';
import { installHtml } from '../src/cli/install.js';

void test('secure reads reject symlinks and non-files without reading their targets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-files-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const target = join(directory, 'private.txt');
  const alias = join(directory, 'index.html');
  await writeFile(target, '<head></head><body>Private</body>');
  await symlink(target, alias);
  await assert.rejects(readRegularFile(alias));
  await assert.rejects(installHtml(alias, 'snippet'));
  await assert.rejects(readRegularFile(directory), /regular file/);
  assert.equal(await readFile(target, 'utf8'), '<head></head><body>Private</body>');
});

void test('atomic replacement does not follow a destination symlink and preserves private mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-replace-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const target = join(directory, 'unrelated.txt');
  const path = join(directory, 'credentials.json');
  await writeFile(target, 'Unchanged');
  await symlink(target, path);
  await replaceFile(path, '{"connection":"saved"}', 0o600);
  assert.equal(await readFile(target, 'utf8'), 'Unchanged');
  assert.equal((await readRegularFile(path)).contents.toString('utf8'), '{"connection":"saved"}');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

void test('HTML installation ignores an attacker-created legacy temporary symlink', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-install-safe-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const target = join(directory, 'unrelated.txt');
  const path = join(directory, 'index.html');
  await writeFile(target, 'Unchanged');
  await writeFile(path, '<head></head><body>Website</body>');
  await symlink(target, `${path}.feedback-toolbar.${process.pid}.tmp`);
  await installHtml(path, '<script src="https://feedback.example/embed.js"></script>');
  assert.equal(await readFile(target, 'utf8'), 'Unchanged');
  assert.ok((await readFile(path, 'utf8')).includes('feedback-toolbar:start'));
});
