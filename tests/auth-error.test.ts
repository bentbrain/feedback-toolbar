import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthentication } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';

void test('failed session lookups omit internal error causes from HTTP responses', async (t) => {
  const store = new Store(':memory:');
  t.after(() => {
    store.close();
  });
  const url = 'http://localhost:4310';
  const auth = createAuthentication({
    database: store.authDatabase,
    url,
    secret: 'synthetic-authentication-secret-for-tests-only',
    localPassword: true,
  });
  const signup = await auth.handler(
    new Request(`${url}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test owner',
        email: 'owner@example.invalid',
        password: 'synthetic-password-for-tests-only',
      }),
    }),
  );
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const context = await auth.$context;
  context.internalAdapter.findSession = () =>
    Promise.reject(
      Object.assign(new Error('Synthetic session lookup failure'), {
        query: 'SELECT synthetic_private_session',
        params: ['synthetic-private-parameter'],
      }),
    );
  const response = await auth.handler(
    new Request(`${url}/api/auth/get-session`, { headers: { Cookie: cookie } }),
  );
  assert.equal(response.status, 500);
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  assert.ok(body && typeof body === 'object');
  assert.equal('cause' in body, false);
  assert.equal(text.includes('synthetic_private_session'), false);
  assert.equal(text.includes('synthetic-private-parameter'), false);
});
