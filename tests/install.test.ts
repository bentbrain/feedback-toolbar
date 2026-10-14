import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectHtml, installHtml } from '../src/cli/install.js';

void test('HTML installation is repeatable, replaces project config, and preserves existing source', () => {
  const source = '<!doctype html><head><title>My app</title></head><body>Hello</body>';
  const first = injectHtml(
    source,
    '<script src="https://feedback.example/embed.js" data-project="one"></script>',
  );
  assert.equal(
    injectHtml(
      first,
      '<script src="https://feedback.example/embed.js" data-project="one"></script>',
    ),
    first,
  );
  const updated = injectHtml(
    first,
    '<script src="https://feedback.example/embed.js" data-project="two"></script>',
  );
  assert.equal((updated.match(/feedback-toolbar:start/g) ?? []).length, 1);
  assert.ok(updated.includes('data-project="two"'));
  assert.ok(updated.includes('<body>Hello</body>'));
});
void test('HTML installation refuses ambiguous markers and non-HTML files and keeps a backup', async (t) => {
  assert.throws(() => injectHtml('<head><!-- feedback-toolbar:start --></head>', 'snippet'));
  const directory = await mkdtemp(join(tmpdir(), 'feedback-install-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'index.html');
  const source = '<head></head><body>Original</body>';
  await writeFile(path, source);
  const first = await installHtml(
    path,
    '<script src="https://feedback.example/embed.js"></script>',
  );
  assert.equal(first.changed, true);
  assert.equal(await readFile(`${path}.feedback-toolbar.bak`, 'utf8'), source);
  const second = await installHtml(
    path,
    '<script src="https://feedback.example/embed.js"></script>',
  );
  assert.equal(second.changed, false);
  await assert.rejects(installHtml(join(directory, 'layout.tsx'), 'snippet'), /HTML entry points/);
});
