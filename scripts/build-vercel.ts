import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { originSchema } from '../src/shared/models.js';

const api = originSchema.parse(process.env.FEEDBACK_API_ORIGIN ?? 'http://localhost:8787');
const service = originSchema.parse(process.env.FEEDBACK_URL ?? 'http://localhost:4310');
const target = '.vercel/output';
await rm(target, { recursive: true, force: true });
await mkdir(`${target}/static`, { recursive: true });
for (const asset of ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'])
  await copyFile(`dist/${asset}`, `${target}/static/${asset}`);
await copyFile('assets/icon.svg', `${target}/static/icon.svg`);
if (api === service) throw new Error('The API example and toolbar require separate origins.');
await writeFile(
  `${target}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/example', status: 307, headers: { Location: `${api}/example` } },
        {
          src: '/embed(?:-module)?\\.js',
          headers: {
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'public, max-age=300',
          },
          continue: true,
        },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: `${api}/$1`, headers: { 'Cache-Control': 'no-store' } },
      ],
    },
    null,
    2,
  ),
);
console.log('Prepared Vercel assets and API proxy routes.');
