import { test, expect } from './fixtures.js';
import { build } from 'esbuild';
import type { createConnectionStore } from '../src/browser/connection-store.js';

declare global {
  interface Window {
    connectionStoreModule: { createConnectionStore: typeof createConnectionStore };
    testConnection: ReturnType<typeof createConnectionStore>;
  }
}

test('copied tabs coordinate single-use refresh tokens and sign out the shared grant', async ({
  page,
  context,
}) => {
  const built = await build({
    entryPoints: ['src/browser/connection-store.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'connectionStoreModule',
    write: false,
  });
  const script = built.outputFiles[0]?.text;
  if (!script) throw new Error('Connection store test bundle missing.');
  let refreshes = 0;
  let revoked = false;
  await context.route('**/connection-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script src="/connection-test.js"></script>',
    }),
  );
  await context.route('**/connection-test.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: script }),
  );
  await context.route('**/api/auth/oauth2/token', async (route) => {
    const input = new URLSearchParams(route.request().postData() ?? '');
    if (input.get('refresh_token') !== `refresh-${refreshes}` || revoked) {
      revoked = true;
      await route.fulfill({ status: 400, json: { error: 'invalid_grant' } });
      return;
    }
    refreshes++;
    await route.fulfill({
      json: {
        access_token: `access-${refreshes}`,
        refresh_token: `refresh-${refreshes}`,
        expires_in: 900,
      },
    });
  });
  await context.route('**/api/auth/oauth2/revoke', async (route) => {
    revoked = true;
    await route.fulfill({ json: {} });
  });
  await page.goto('/connection-test');
  await page.evaluate(() => {
    window.testConnection = window.connectionStoreModule.createConnectionStore(
      'copied-grant',
      location.origin,
    );
    window.testConnection.start({
      token: 'access-0',
      refreshToken: 'refresh-0',
      clientId: 'test-client',
      expiresAt: Date.now() - 1,
    });
  });
  const popupEvent = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.open('/connection-test');
  });
  const copied = await popupEvent;
  await copied.waitForLoadState();
  const initial = await copied.evaluate(() => {
    window.testConnection = window.connectionStoreModule.createConnectionStore(
      'copied-grant',
      location.origin,
    );
    return window.testConnection.read()?.token;
  });
  expect(initial).toBe('access-0');
  const tokens = await Promise.all([
    page.evaluate(async () => (await window.testConnection.current()).token),
    copied.evaluate(async () => (await window.testConnection.current()).token),
  ]);
  expect(tokens).toEqual(['access-1', 'access-1']);
  expect(refreshes).toBe(1);
  expect(revoked).toBe(false);
  await page.reload();
  expect(
    await page.evaluate(() => {
      window.testConnection = window.connectionStoreModule.createConnectionStore(
        'copied-grant',
        location.origin,
      );
      return window.testConnection.read()?.token;
    }),
  ).toBe('access-1');
  await copied.evaluate(() => window.testConnection.signOut());
  expect(await page.evaluate(() => window.testConnection.read())).toBeNull();
  expect(revoked).toBe(true);
  await copied.close();
});

test('browsers without rotation coordination keep grants in memory and require a new approval on reload', async ({
  page,
}) => {
  const built = await build({
    entryPoints: ['src/browser/connection-store.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'connectionStoreModule',
    write: false,
  });
  const script = built.outputFiles[0]?.text;
  if (!script) throw new Error('Connection store test bundle missing.');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined });
  });
  await page.route('**/connection-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script src="/connection-test.js"></script>',
    }),
  );
  await page.route('**/connection-test.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: script }),
  );
  let refreshes = 0;
  await page.route('**/api/auth/oauth2/token', async (route) => {
    refreshes++;
    await route.fulfill({
      json: { access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 900 },
    });
  });
  await page.goto('/connection-test');
  const state = await page.evaluate(async () => {
    const store = window.connectionStoreModule.createConnectionStore(
      'memory-grant',
      location.origin,
    );
    store.start({
      token: 'access',
      refreshToken: 'refresh',
      clientId: 'test-client',
      expiresAt: Date.now() - 1,
    });
    const renewed = await Promise.all([store.current(), store.current(), store.current()]);
    return {
      tokens: renewed.map((connection) => connection.token),
      persisted: sessionStorage.getItem('memory-grant'),
    };
  });
  expect(state).toEqual({
    tokens: ['renewed-access', 'renewed-access', 'renewed-access'],
    persisted: null,
  });
  expect(refreshes).toBe(1);
  await page.reload();
  expect(
    await page.evaluate(() =>
      window.connectionStoreModule.createConnectionStore('memory-grant', location.origin).read(),
    ),
  ).toBeNull();
});

test('transient OAuth refresh failures retain a grant for retry while missing grants are terminal', async ({
  page,
}) => {
  const built = await build({
    entryPoints: ['src/browser/connection-store.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'connectionStoreModule',
    write: false,
  });
  const script = built.outputFiles[0]?.text;
  if (!script) throw new Error('Connection store bundle missing');
  await page.route('**/connection-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script src="/connection-test.js"></script>',
    }),
  );
  await page.route('**/connection-test.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: script }),
  );
  let attempts = 0;
  await page.route('**/api/auth/oauth2/token', (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } })
      : route.fulfill({
          json: {
            access_token: 'renewed-access',
            refresh_token: 'renewed-refresh',
            expires_in: 900,
          },
        });
  });
  await page.goto('/connection-test');
  const result = await page.evaluate(async () => {
    const store = window.connectionStoreModule.createConnectionStore(
      'retry-grant',
      location.origin,
    );
    store.start({
      token: 'original-access',
      refreshToken: 'original-refresh',
      clientId: 'retry-client',
      expiresAt: Date.now() - 1,
    });
    let transient: unknown;
    try {
      await store.current();
    } catch (error) {
      if (error instanceof Error && 'terminal' in error) transient = error.terminal;
    }
    const retained = store.read()?.token;
    const renewed = (await store.current()).token;
    store.clear();
    let missing: unknown;
    try {
      await store.current();
    } catch (error) {
      if (error instanceof Error && 'terminal' in error) missing = error.terminal;
    }
    return { transient, retained, renewed, missing };
  });
  expect(result).toEqual({
    transient: false,
    retained: 'original-access',
    renewed: 'renewed-access',
    missing: true,
  });
  expect(attempts).toBe(2);
});
