import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import {
  retainActiveAssets,
  verifyPublishedAssets,
  waitForDeploymentReady,
} from '../scripts/release-assets.js';
import { releaseFiles } from '../scripts/release-artifacts.js';

void test('canonical asset propagation preserves the active release and eventually verifies exact new bytes', async (t) => {
  const active = '1'.repeat(40);
  const next = '2'.repeat(40);
  let attempts = 0;
  let elapsed = 0;
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, assetVersion: active }));
  app.get('/assets/:version/:file', (c) => {
    if (c.req.param('version') === next && c.req.param('file') === 'app.js' && ++attempts < 3)
      return c.notFound();
    return c.text(`${c.req.param('version')}:${c.req.param('file')}`);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => {
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'feedback-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await retainActiveAssets(directory, origin, next, async (version, destination) => {
    for (const file of releaseFiles)
      await writeFile(`${destination}/${file}`, `${version}:${file}`);
  });
  await mkdir(`${directory}/${next}`);
  for (const file of releaseFiles)
    await writeFile(`${directory}/${next}/${file}`, `${next}:${file}`);
  await verifyPublishedAssets(directory, origin, {
    timeoutMs: 1000,
    intervalMs: 100,
    now: () => elapsed,
    pause: async (milliseconds) => {
      assert.equal(
        await (await fetch(`${origin}/assets/${active}/app.js`)).text(),
        `${active}:app.js`,
      );
      elapsed += milliseconds;
    },
  });
  assert.equal(attempts, 3);
  assert.equal(elapsed, 200);
});

async function httpFixture(
  t: TestContext,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => {
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
  return `http://127.0.0.1:${address.port}`;
}
async function assetDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '3'.repeat(40);
  await mkdir(`${directory}/${version}`);
  for (const file of releaseFiles)
    await writeFile(`${directory}/${version}/${file}`, `${version}:${file}`);
  return { directory, version };
}
function fastClock() {
  let elapsed = 0;
  let pauses = 0;
  return {
    options: {
      timeoutMs: 250,
      intervalMs: 100,
      now: () => elapsed,
      pause: (milliseconds: number) => {
        elapsed += milliseconds;
        pauses++;
        return Promise.resolve();
      },
    },
    elapsed: () => elapsed,
    pauses: () => pauses,
  };
}

void test('READY waits for alias assignment before checking canonical assets', async (t) => {
  const { directory, version } = await assetDirectory(t);
  const clock = fastClock();
  let reads = 0;
  let assetReads = 0;
  const origin = await httpFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/deployment')
      return Response.json({ readyState: 'READY', aliasAssigned: ++reads >= 3, aliasError: null });
    assert.equal(reads, 3, 'Canonical assets must not be checked before aliases are assigned');
    assetReads++;
    return new Response(`${version}:${path.split('/').at(-1) ?? ''}`);
  });
  await waitForDeploymentReady(
    async (signal) => (await fetch(`${origin}/deployment`, { signal })).json(),
    clock.options,
  );
  await verifyPublishedAssets(directory, origin);
  assert.equal(reads, 3);
  assert.equal(assetReads, releaseFiles.length);
  assert.equal(clock.elapsed(), 200);
});

for (const scenario of [
  {
    readyState: 'READY',
    aliasAssigned: true,
    aliasError: { code: 'ALIAS_FAILED', message: 'Alias could not be assigned.' },
  },
  { readyState: 'ERROR', aliasAssigned: true, aliasError: null },
  { readyState: 'CANCELED', aliasAssigned: false, aliasError: null },
  { readyState: 'READY', aliasError: null },
]) {
  void test(`deployment fails closed for ${JSON.stringify(scenario)}`, async (t) => {
    const clock = fastClock();
    let reads = 0;
    const origin = await httpFixture(t, () => {
      reads++;
      return Response.json(scenario);
    });
    await assert.rejects(
      waitForDeploymentReady(
        async (signal) => (await fetch(origin, { signal })).json(),
        clock.options,
      ),
    );
    assert.equal(reads, 1);
    assert.equal(clock.pauses(), 0);
  });
}
void test('alias assignment has a bounded wait even when READY never receives aliases', async (t) => {
  const clock = fastClock();
  let reads = 0;
  const origin = await httpFixture(t, () => {
    reads++;
    return Response.json({ readyState: 'READY', aliasAssigned: false, aliasError: null });
  });
  await assert.rejects(
    waitForDeploymentReady(
      async (signal) => (await fetch(origin, { signal })).json(),
      clock.options,
    ),
    /timed out/,
  );
  assert.equal(reads, 3);
  assert.equal(clock.elapsed(), 250);
});

for (const status of [404, 408, 429, 500, 502, 503, 504]) {
  void test(`canonical GET ${status} can propagate to exact bytes within the deadline`, async (t) => {
    const { directory, version } = await assetDirectory(t);
    const clock = fastClock();
    let attempts = 0;
    const origin = await httpFixture(t, (request) => {
      if (new URL(request.url).pathname.endsWith('/app.js') && ++attempts === 1)
        return new Response('Not ready', { status });
      return new Response(`${version}:${new URL(request.url).pathname.split('/').at(-1) ?? ''}`);
    });
    await verifyPublishedAssets(directory, origin, clock.options);
    assert.equal(attempts, 2);
    assert.equal(clock.pauses(), 1);
  });
}
void test('missing canonical assets exhaust the propagation deadline and cannot activate a release', async (t) => {
  const { directory } = await assetDirectory(t);
  const clock = fastClock();
  let attempts = 0;
  const origin = await httpFixture(t, () => {
    attempts++;
    return new Response('Not ready', { status: 404 });
  });
  await assert.rejects(
    verifyPublishedAssets(directory, origin, clock.options),
    /propagation timed out/,
  );
  assert.equal(attempts, 3);
  assert.equal(clock.elapsed(), 250);
});
for (const status of [301, 400, 401, 403, 410, 422, 501]) {
  void test(`permanent canonical response ${status} fails immediately`, async (t) => {
    const { directory } = await assetDirectory(t);
    const clock = fastClock();
    let attempts = 0;
    const origin = await httpFixture(t, () => {
      attempts++;
      return new Response('Unavailable', { status, headers: { Location: '/redirect-target' } });
    });
    await assert.rejects(
      verifyPublishedAssets(directory, origin, clock.options),
      (error: unknown) =>
        error instanceof Error && error.message.includes(`unavailable (${status})`),
    );
    assert.equal(attempts, 1);
    assert.equal(clock.pauses(), 0);
  });
}
void test('corrupted bytes after propagation fail immediately, including same-length corruption', async (t) => {
  const { directory, version } = await assetDirectory(t);
  const clock = fastClock();
  let attempts = 0;
  const origin = await httpFixture(t, () => {
    attempts++;
    return attempts === 1
      ? new Response('Not ready', { status: 404 })
      : new Response('x'.repeat(`${version}:app.js`.length));
  });
  await assert.rejects(verifyPublishedAssets(directory, origin, clock.options), /differs/);
  assert.equal(attempts, 2);
  assert.equal(clock.pauses(), 1);
});
void test('ordinary asset verification remains fail-fast on 404', async (t) => {
  const { directory } = await assetDirectory(t);
  let attempts = 0;
  const origin = await httpFixture(t, () => {
    attempts++;
    return new Response('Not ready', { status: 404 });
  });
  await assert.rejects(verifyPublishedAssets(directory, origin), /unavailable/);
  assert.equal(attempts, 1);
});

void test('real prebuilt output pins the compiled Node proxy to Sydney and preserves release bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-prebuilt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  await symlink(join(root, 'src'), join(directory, 'src'), 'dir');
  await symlink(join(root, 'assets'), join(directory, 'assets'), 'dir');
  await mkdir(join(directory, 'dist'));
  const version = '4'.repeat(40);
  const paths = [
    'toolbar.js',
    'embed.js',
    'embed-module.js',
    'styles.css',
    'dashboard-assets/entry-HASH.js',
    'dashboard-assets/feedback-HASH.js',
    'dashboard-assets/styles-HASH.css',
    'dashboard-assets/geist-HASH.woff2',
  ];
  await mkdir(join(directory, 'dist/dashboard/client/dashboard-assets'), { recursive: true });
  await writeFile(
    join(directory, 'dist/dashboard/client/index.html'),
    `<script src="/assets/${version}/dashboard-assets/entry-HASH.js"></script>`,
  );
  await writeFile(join(directory, 'dist/browser-assets.json'), JSON.stringify(paths));
  for (const file of paths)
    await writeFile(
      join(
        directory,
        file.startsWith('dashboard-assets/') ? 'dist/dashboard/client' : 'dist',
        file,
      ),
      file.endsWith('.woff2') ? Buffer.from([0, 255, 128, 1]) : `browser:${file}`,
    );
  const run = promisify(execFile);
  await run(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), join(root, 'scripts/build-vercel.ts')],
    {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_SHA: version,
        FEEDBACK_URL: 'http://localhost:44320',
        FEEDBACK_API_ORIGIN: 'http://localhost:8787',
      },
    },
  );
  const output = join(directory, '.vercel/output');
  const config = z
    .object({
      runtime: z.literal('nodejs24.x'),
      handler: z.literal('index.mjs'),
      regions: z.array(z.string()),
    })
    .parse(
      JSON.parse(await readFile(join(output, 'functions/proxy.func/.vc-config.json'), 'utf8')),
    );
  assert.deepEqual(config.regions, ['syd1']);
  assert.ok((await readFile(join(output, 'functions/proxy.func', config.handler))).length > 0);
  for (const file of paths)
    assert.deepEqual(
      await readFile(join(output, 'static/assets', version, file)),
      await readFile(
        join(
          directory,
          file.startsWith('dashboard-assets/') ? 'dist/dashboard/client' : 'dist',
          file,
        ),
      ),
    );
  await assert.rejects(
    run(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), join(root, 'scripts/build-vercel.ts')],
      {
        cwd: directory,
        env: { ...process.env, GITHUB_SHA: '5'.repeat(40) },
      },
    ),
    /Dashboard asset base differs/,
  );
});

void test('a response arriving after the readiness deadline cannot authorize publication', async (t) => {
  let elapsed = 0;
  const origin = await httpFixture(t, () =>
    Response.json({ readyState: 'READY', aliasAssigned: true, aliasError: null }),
  );
  await assert.rejects(
    waitForDeploymentReady(
      async (signal) => {
        const result: unknown = await (await fetch(origin, { signal })).json();
        elapsed = 1000;
        return result;
      },
      { timeoutMs: 1000, now: () => elapsed },
    ),
    /timed out/,
  );
});

void test('the propagation deadline is shared across assets', async (t) => {
  const { directory, version } = await assetDirectory(t);
  const clock = fastClock();
  let appAttempts = 0;
  let toolbarAttempts = 0;
  const origin = await httpFixture(t, (request) => {
    const file = new URL(request.url).pathname.split('/').at(-1) ?? '';
    if (file === 'app.js' && ++appAttempts === 1) return new Response('Not ready', { status: 404 });
    if (file === 'toolbar.js') {
      toolbarAttempts++;
      return new Response('Not ready', { status: 404 });
    }
    return new Response(`${version}:${file}`);
  });
  await assert.rejects(
    verifyPublishedAssets(directory, origin, clock.options),
    /propagation timed out/,
  );
  assert.equal(appAttempts, 2);
  assert.equal(toolbarAttempts, 2);
  assert.equal(clock.elapsed(), 250);
});

void test('a reset canonical GET can retry without accepting different bytes', async (t) => {
  const { directory, version } = await assetDirectory(t);
  const clock = fastClock();
  let resets = 0;
  const server = createServer((request, response) => {
    if (resets === 0) {
      resets++;
      request.socket.destroy();
      return;
    }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const asset = releaseFiles.find((file) => request.url === `/assets/${version}/${file}`);
    if (!asset) {
      response.statusCode = 404;
      response.end('Not found.');
      return;
    }
    response.end(`${version}:${asset}`);
  });
  t.after(() => {
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
  await verifyPublishedAssets(directory, `http://127.0.0.1:${address.port}`, clock.options);
  assert.equal(resets, 1);
  assert.equal(clock.pauses(), 1);
});

for (const phase of ['readiness', 'assets']) {
  void test(`${phase} deadline aborts an in-flight HTTP body`, async (t) => {
    const { directory } = await assetDirectory(t);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"readyState":');
      // Keep the body open until the verifier's deadline aborts the connection.
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
    const origin = `http://127.0.0.1:${address.port}`;
    if (phase === 'readiness') {
      await assert.rejects(
        waitForDeploymentReady(async (signal) => (await fetch(origin, { signal })).json(), {
          timeoutMs: 100,
        }),
        (error: unknown) =>
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name),
      );
    } else {
      await assert.rejects(
        verifyPublishedAssets(directory, origin, { timeoutMs: 100 }),
        /propagation timed out/,
      );
    }
  });
}
