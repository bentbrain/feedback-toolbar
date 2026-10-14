import { serve } from '@hono/node-server';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { Store } from './store.js';
import { originSchema } from '../shared/models.js';
import { readRegularFile, replaceFile } from '../shared/files.js';
import { token } from './security.js';

const port = Number(process.env.PORT ?? 4310);
const demoPort = Number(process.env.DEMO_PORT ?? 4311);
const host = process.env.HOST ?? '127.0.0.1';
const url = originSchema.parse(process.env.FEEDBACK_URL ?? `http://localhost:${port}`);
const demoUrl = `http://localhost:${demoPort}`;
const directory = process.env.FEEDBACK_DATA_DIR ?? '.data';
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const store = new Store(`${directory}/feedback.db`);
chmodSync(`${directory}/feedback.db`, 0o600);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
let secret = process.env.BETTER_AUTH_SECRET;
if (!secret && local) {
  const path = `${directory}/auth-secret`;
  try {
    secret = (await readRegularFile(path)).contents.toString('utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    secret = token();
    await replaceFile(path, secret, 0o600);
  }
}
if (!secret) throw new Error('Configure BETTER_AUTH_SECRET before starting the service.');
const app = createApp({
  store,
  url,
  demoUrl,
  allowSignup: process.env.FEEDBACK_ALLOW_SIGNUP !== 'false',
  authentication: {
    secret,
    localPassword: local,
    github:
      process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET
        ? {
            clientId: process.env.AUTH_GITHUB_CLIENT_ID,
            clientSecret: process.env.AUTH_GITHUB_CLIENT_SECRET,
          }
        : undefined,
  },
  asset: (file) => readFile(file),
});
const server = serve({
  fetch: (request, env) => {
    const headers = new Headers(request.headers);
    headers.set('x-feedback-client-ip', env.incoming.socket.remoteAddress ?? '127.0.0.1');
    return app.fetch(new Request(request, { headers }));
  },
  port,
  hostname: host,
});
const demo = new Hono();
demo.get('/', async (c) =>
  c.html((await readFile('public/demo.html', 'utf8')).replaceAll('__FEEDBACK_URL__', url)),
);
const example = serve({ fetch: demo.fetch, port: demoPort, hostname: host });
console.log(
  `Feedback service: ${url}\nExample website: ${demoUrl}\nDatabase: ${directory}/feedback.db`,
);
let closed = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (closed) return;
    closed = true;
    server.close();
    example.close();
    store.close();
  });
