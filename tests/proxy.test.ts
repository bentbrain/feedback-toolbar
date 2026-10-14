import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { token } from '../src/server/security.js';
import { signProxyRequest, verifiedProxyIp } from '../src/server/proxy-signature.js';

void test('proxy identity requires an authentic signature bound to IP, method, path and time', async () => {
  const secret = token();
  const request = new Request('https://feedback.example/api/auth/oauth2/token?client=test', {
    method: 'POST',
  });
  const signed = await signProxyRequest(request, '203.0.113.25', secret);
  const headers = new Headers({
    'x-feedback-client-ip': signed.ip,
    'x-feedback-proxy-time': signed.timestamp,
    'x-feedback-proxy-signature': signed.signature,
  });
  assert.equal(await verifiedProxyIp(new Request(request, { headers }), secret), signed.ip);
  assert.equal(await verifiedProxyIp(new Request(request, { headers }), token()), null);
  const forged = new Headers(headers);
  forged.set('x-feedback-client-ip', '203.0.113.26');
  assert.equal(await verifiedProxyIp(new Request(request, { headers: forged }), secret), null);
  assert.equal(
    await verifiedProxyIp(
      new Request('https://feedback.example/api/account/revoke-all', { method: 'POST', headers }),
      secret,
    ),
    null,
  );
  assert.equal(
    await verifiedProxyIp(new Request(request.url, { method: 'GET', headers }), secret),
    null,
  );
  const expired = new Headers(headers);
  expired.set('x-feedback-proxy-time', String(Date.now() - 120_000));
  assert.equal(await verifiedProxyIp(new Request(request, { headers: expired }), secret), null);
  assert.equal(await verifiedProxyIp(request, secret), null);
});

void test('the Vercel function replaces forged visitor headers and preserves redirects and cookies', async (t) => {
  const { createServer, request: send } = await import('node:http');
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { z } = await import('zod');
  const { default: proxy } = await import('../src/server/vercel-proxy.js');
  const secret = token();
  const previousSecret = process.env.FEEDBACK_PROXY_SECRET;
  const previousOrigin = process.env.FEEDBACK_API_ORIGIN;
  const previousService = process.env.FEEDBACK_URL;
  const previousLegacy = process.env.FEEDBACK_PREVIOUS_URL;
  const backend = new Hono();
  let requests = 0;
  let activeOrigin = '';
  backend.get('/api/config', async (c) => {
    assert.equal(await verifiedProxyIp(c.req.raw, secret), '203.0.113.44');
    assert.equal(c.req.header('Authorization'), undefined);
    assert.equal(c.req.header('Cookie'), undefined);
    return c.json({ url: activeOrigin });
  });
  backend.post('/api/mutate', async (c) => {
    requests++;
    assert.equal(await verifiedProxyIp(c.req.raw, secret), '203.0.113.44');
    if (c.req.header('Origin') !== activeOrigin) return c.json({ error: 'Wrong origin.' }, 403);
    return c.json({ ok: true });
  });
  backend.all('*', async (c) => {
    requests++;
    assert.equal(await verifiedProxyIp(c.req.raw, secret), '203.0.113.44');
    assert.equal(c.req.header('Origin'), 'https://feedback.example');
    assert.equal(c.req.header('Idempotency-Key'), 'setup-fixture');
    c.header('Set-Cookie', 'fixture_session=fixture; HttpOnly; SameSite=Lax');
    return c.redirect('https://github.com/login', 302);
  });
  const api = serve({ fetch: backend.fetch, port: 0, hostname: '127.0.0.1' });
  await once(api, 'listening');
  process.env.FEEDBACK_API_ORIGIN = `http://127.0.0.1:${z.object({ port: z.number() }).parse(api.address()).port}`;
  process.env.FEEDBACK_PROXY_SECRET = secret;
  const server = createServer((req, res) => {
    void proxy(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.close();
    api.close();
    if (previousLegacy === undefined) delete process.env.FEEDBACK_PREVIOUS_URL;
    else process.env.FEEDBACK_PREVIOUS_URL = previousLegacy;
    if (previousService === undefined) delete process.env.FEEDBACK_URL;
    else process.env.FEEDBACK_URL = previousService;
    if (previousSecret === undefined) delete process.env.FEEDBACK_PROXY_SECRET;
    else process.env.FEEDBACK_PROXY_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.FEEDBACK_API_ORIGIN;
    else process.env.FEEDBACK_API_ORIGIN = previousOrigin;
  });
  const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  activeOrigin = origin;
  process.env.FEEDBACK_URL = 'https://toolbar.example';
  process.env.FEEDBACK_PREVIOUS_URL = origin;
  const headers = {
    'x-vercel-forwarded-for': '203.0.113.44',
    'x-feedback-client-ip': '203.0.113.99',
    Origin: 'https://feedback.example',
    'Idempotency-Key': 'setup-fixture',
  };
  const response = await fetch(`${origin}/api/auth/callback/github?code=fixture&state=fixture`, {
    headers,
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://github.com/login');
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/);
  const large = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers,
    body: 'x'.repeat(40_000),
  });
  assert.equal(large.status, 413);
  assert.equal(requests, 1);
  const publicRequest = async (path: string, method = 'GET') => {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = send(
        `${origin}${path}`,
        {
          method,
          headers: {
            ...headers,
            Host: 'toolbar.example',
            Origin: method === 'POST' ? 'https://toolbar.example' : headers.Origin,
            'x-forwarded-proto': 'https',
          },
        },
        (response) => {
          response.resume();
          resolve(response);
        },
      );
      request.on('error', reject);
      request.end(method === 'POST' ? '{}' : undefined);
    });
    return { status: response.statusCode, location: response.headers.location };
  };
  // Publishing the new frontend cannot enable its host until the Worker changes origins.
  for (let interruptedAttempt = 0; interruptedAttempt < 2; interruptedAttempt++) {
    const previous = await fetch(`${origin}/api/mutate`, {
      method: 'POST',
      headers: { ...headers, Origin: origin },
      body: '{}',
    });
    assert.equal(previous.status, 200);
    const premature = await publicRequest('/api/mutate', 'POST');
    assert.equal(premature.status, 403);
  }
  activeOrigin = 'https://toolbar.example';
  // The adapter sees an HTTP socket; the public canonical HTTPS Host must still work.
  const activated = await publicRequest('/api/mutate', 'POST');
  assert.equal(activated.status, 200);
  const canonicalGet = await publicRequest('/auth');
  assert.equal(canonicalGet.status, 302);
  assert.equal(canonicalGet.location, 'https://github.com/login');
  const migrated = await fetch(`${origin}/auth?user_code=fixture`, { headers, redirect: 'manual' });
  assert.equal(migrated.status, 307);
  assert.equal(migrated.headers.get('location'), 'https://toolbar.example/auth?user_code=fixture');
  const rejected = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(rejected.status, 403);
  assert.equal(requests, 5);
  activeOrigin = 'https://unregistered.example';
  const unsafe = await fetch(`${origin}/auth`, { headers, redirect: 'manual' });
  assert.equal(unsafe.status, 502);
  assert.equal(unsafe.headers.get('location'), null);
  assert.equal(requests, 5);
});
