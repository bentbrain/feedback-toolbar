import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { retainActiveAssets } from './release-assets.js';
import { browserAssetSource, localBrowserAssets } from './release-artifacts.js';
import { dirname } from 'node:path';
import { originSchema } from '../src/shared/models.js';

const api = originSchema.parse(process.env.FEEDBACK_API_ORIGIN ?? 'http://localhost:8787');
const service = originSchema.parse(process.env.FEEDBACK_URL ?? 'http://localhost:4310');
const target = '.vercel/output';
const release = process.env.GITHUB_SHA;
if (release && !/^[a-f0-9]{40}$/.test(release)) throw new Error('Invalid release identifier.');
if (release) {
  const document = await readFile('dist/dashboard/client/index.html', 'utf8');
  if (!document.includes(`/assets/${release}/dashboard-assets/`))
    throw new Error(
      'Dashboard asset base differs from the publication release. Rebuild with the same GITHUB_SHA.',
    );
}
await rm(target, { recursive: true, force: true });
await mkdir(`${target}/static`, { recursive: true });
await mkdir(`${target}/functions/proxy.func`, { recursive: true });
await build({
  entryPoints: ['src/server/vercel-proxy.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: `${target}/functions/proxy.func/index.mjs`,
  minify: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await writeFile(
  `${target}/functions/proxy.func/.vc-config.json`,
  JSON.stringify({
    runtime: 'nodejs24.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    regions: ['syd1'],
  }),
);
if (release) await mkdir(`${target}/static/assets/${release}`, { recursive: true });
for (const asset of await localBrowserAssets('dist')) {
  const source = browserAssetSource('dist', asset);
  const destination = `${target}/static/${asset}`;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (release) {
    const versioned = `${target}/static/assets/${release}/${asset}`;
    await mkdir(dirname(versioned), { recursive: true });
    await copyFile(source, versioned);
  }
}
if (process.argv.includes('--retain-active')) {
  if (!release) throw new Error('A deployment release identifier is required.');
  await retainActiveAssets(`${target}/static/assets`, service, release);
}
await copyFile('assets/icon.svg', `${target}/static/icon.svg`);
if (api === service) throw new Error('The API example and toolbar require separate origins.');
await writeFile(
  `${target}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: '/embed(?:-module)?\\.js',
          headers: {
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'public, max-age=300',
          },
          continue: true,
        },
        {
          src: '/assets/[a-f0-9]{40}/.*',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/proxy', headers: { 'Cache-Control': 'no-store' } },
      ],
    },
    null,
    2,
  ),
);
console.log('Prepared Vercel assets and API proxy routes.');
