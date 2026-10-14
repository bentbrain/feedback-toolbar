import { createHash } from 'node:crypto';
import { verifyReleaseArtifacts } from '../scripts/release-artifacts.js';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { retainActiveAssets, verifyPublishedAssets } from '../scripts/release-assets.js';

void test('asset publication retains the running Worker release across interrupted deployments and rejects missing or incorrect assets', async (t) => {
  const active = '1'.repeat(40);
  const failedActivation = '2'.repeat(40);
  const next = '3'.repeat(40);
  const files = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
  const published = new Map(
    files.map((file) => [`/assets/${active}/${file}`, `${active}:${file}`]),
  );
  let health = 200;
  const app = new Hono();
  app.get('/health', (c) =>
    health === 200
      ? c.json({ ok: true, assetVersion: active })
      : new Response('', { status: health }),
  );
  app.get('/assets/*', (c) => {
    const asset = published.get(c.req.path);
    return asset === undefined ? c.notFound() : c.text(asset);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => {
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing.');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'feedback-release-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const retrieve = async (version: string, destination: string) => {
    assert.equal(version, active);
    for (const file of files) await writeFile(`${destination}/${file}`, `${active}:${file}`);
  };
  await retainActiveAssets(directory, origin, failedActivation, retrieve);
  for (const file of files)
    assert.equal(await readFile(`${directory}/${active}/${file}`, 'utf8'), `${active}:${file}`);
  await mkdir(`${directory}/${next}`);
  for (const file of files) await writeFile(`${directory}/${next}/${file}`, `${next}:${file}`);
  await assert.rejects(verifyPublishedAssets(directory, origin), /unavailable/);
  for (const file of files) published.set(`/assets/${next}/${file}`, `${next}:${file}`);
  await verifyPublishedAssets(directory, origin);
  published.set(`/assets/${next}/toolbar.js`, 'corrupted');
  await assert.rejects(verifyPublishedAssets(directory, origin), /differs/);
  // Even after an asset-only deployment, the Worker still reports the active release.
  await retainActiveAssets(directory, origin, next, retrieve);
  assert.equal(await readFile(`${directory}/${active}/toolbar.js`, 'utf8'), `${active}:toolbar.js`);
  health = 503;
  await assert.rejects(retainActiveAssets(directory, origin, next, retrieve), /active release/);
  health = 404;
  await retainActiveAssets(directory, origin, next, retrieve);
});

void test('archived release assets must match the commit, exact names, sizes and SHA-256 digests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '4'.repeat(40);
  const files = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
  for (const file of files) await writeFile(`${directory}/${file}`, file);
  const metadata = {
    tag_name: `assets-${version}`,
    target_commitish: version,
    assets: files.map((name) => ({
      name,
      size: Buffer.byteLength(name),
      digest: `sha256:${createHash('sha256').update(name).digest('hex')}`,
    })),
  };
  await verifyReleaseArtifacts(directory, version, metadata);
  await assert.rejects(
    verifyReleaseArtifacts(directory, version, { ...metadata, target_commitish: '5'.repeat(40) }),
    /active commit/,
  );
  await assert.rejects(
    verifyReleaseArtifacts(directory, version, { ...metadata, assets: metadata.assets.slice(1) }),
    /missing/,
  );
  await writeFile(`${directory}/app.js`, 'corrupted');
  await assert.rejects(verifyReleaseArtifacts(directory, version, metadata), /digest differs/);
});
