import { serve } from '@hono/node-server';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { Store } from './store.js';
import { originSchema } from '../shared/models.js';

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
const app = createApp({
  store,
  url,
  demoUrl,
  allowSignup: process.env.FEEDBACK_ALLOW_SIGNUP !== 'false',
  asset: (file) => readFile(file),
});
const server = serve({ fetch: app.fetch, port, hostname: host });
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
