import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { originSchema } from '../src/shared/models.js';
import { readRegularFile } from '../src/shared/files.js';

const versionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const assets = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
async function download(url: string) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Release asset is unavailable (${response.status}): ${url}`);
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.length > 8 * 1024 * 1024) throw new Error('Release asset exceeds the size limit.');
  return contents;
}

export async function retainActiveAssets(directory: string, service: string, release: string) {
  const origin = originSchema.parse(service);
  versionSchema.parse(release);
  const response = await fetch(`${origin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  // A provisioned Vercel domain returns 404 before its first deployment.
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Cannot establish the active release (${response.status}).`);
  const health = z
    .object({ ok: z.literal(true), assetVersion: versionSchema.nullable() })
    .parse(await response.json());
  if (!health.assetVersion || health.assetVersion === release) return;
  const target = `${directory}/${health.assetVersion}`;
  await mkdir(target, { recursive: true });
  for (const asset of assets)
    await writeFile(
      `${target}/${asset}`,
      await download(`${origin}/assets/${health.assetVersion}/${asset}`),
    );
}

export async function verifyPublishedAssets(directory: string, service: string) {
  const origin = originSchema.parse(service);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const version = versionSchema.parse(entry.name);
    if (!entry.isDirectory()) throw new Error('Invalid release asset directory.');
    for (const asset of assets) {
      const expected = (await readRegularFile(`${directory}/${version}/${asset}`)).contents;
      const actual = await download(`${origin}/assets/${version}/${asset}`);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error(`Published release asset differs: ${version}/${asset}`);
    }
  }
}
