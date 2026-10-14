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
  const { createServer } = await import('node:http');
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { z } = await import('zod');
  const { default: proxy } = await import('../src/server/vercel-proxy.js');
  const secret = token();
  const previousSecret = process.env.FEEDBACK_PROXY_SECRET;
  const previousOrigin = process.env.FEEDBACK_API_ORIGIN;
  const previousService = process.env.FEEDBACK_URL;
  const backend = new Hono();
  let requests = 0;
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
    if (previousService === undefined) delete process.env.FEEDBACK_URL;
    else process.env.FEEDBACK_URL = previousService;
    if (previousSecret === undefined) delete process.env.FEEDBACK_PROXY_SECRET;
    else process.env.FEEDBACK_PROXY_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.FEEDBACK_API_ORIGIN;
    else process.env.FEEDBACK_API_ORIGIN = previousOrigin;
  });
  const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  process.env.FEEDBACK_URL = origin;
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
  process.env.FEEDBACK_URL = 'https://toolbar.example';
  const migrated = await fetch(`${origin}/auth?user_code=fixture`, { redirect: 'manual' });
  assert.equal(migrated.status, 307);
  assert.equal(migrated.headers.get('location'), 'https://toolbar.example/auth?user_code=fixture');
  const rejected = await fetch(`${origin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(rejected.status, 403);
  assert.equal(requests, 1);
});
