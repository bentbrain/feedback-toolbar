import type { D1Database } from '@cloudflare/workers-types';
import { createApp } from './app.js';
import { d1Store } from './d1-store.js';
import { originSchema } from '../shared/models.js';
import { digest } from './security.js';
import { verifiedProxyIp } from './proxy-signature.js';
import demo from '../../public/demo.html';

interface Bindings {
  DB: D1Database;
  ASSET_VERSION?: string;
  FEEDBACK_URL: string;
  DEMO_URL?: string;
  FEEDBACK_ALLOW_SIGNUP?: string;
  BETTER_AUTH_SECRET: string;
  FEEDBACK_PROXY_SECRET?: string;
  AUTH_GITHUB_CLIENT_ID?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
}
const applications = new WeakMap<D1Database, Map<string, ReturnType<typeof createApp>>>();
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = originSchema.parse(env.FEEDBACK_URL);
    const incoming = new URL(request.url);
    if (incoming.pathname === '/example')
      return new Response(demo.replaceAll('__FEEDBACK_URL__', url), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    // Vercel proxies browser paths to this Worker. Public URLs always use the configured UI origin.
    const headers = new Headers(request.headers);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    const ip = local
      ? '127.0.0.1'
      : env.FEEDBACK_PROXY_SECRET
        ? await verifiedProxyIp(request, env.FEEDBACK_PROXY_SECRET)
        : null;
    if (!ip)
      return Response.json({ error: 'Use the configured feedback service.' }, { status: 403 });
    headers.set('x-feedback-client-ip', ip);
    const normalized = new Request(
      `${url}${incoming.pathname}${incoming.search}`,
      new Request(request, { headers }),
    );
    let cache = applications.get(env.DB);
    if (!cache) {
      cache = new Map();
      applications.set(env.DB, cache);
    }
    const key = digest(
      JSON.stringify({
        url,
        version: env.ASSET_VERSION,
        secret: env.BETTER_AUTH_SECRET,
        githubId: env.AUTH_GITHUB_CLIENT_ID,
        githubSecret: env.AUTH_GITHUB_CLIENT_SECRET,
        signup: env.FEEDBACK_ALLOW_SIGNUP,
        demoUrl: env.DEMO_URL,
      }),
    );
    let app = cache.get(key);
    if (!app) {
      app = createApp({
        store: d1Store(env.DB),
        assetVersion: env.ASSET_VERSION,
        url,
        demoUrl: env.DEMO_URL ?? `${incoming.origin}/example`,
        allowSignup: env.FEEDBACK_ALLOW_SIGNUP !== 'false',
        authentication: {
          secret: env.BETTER_AUTH_SECRET,
          localPassword: url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'),
          github:
            env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET
              ? { clientId: env.AUTH_GITHUB_CLIENT_ID, clientSecret: env.AUTH_GITHUB_CLIENT_SECRET }
              : undefined,
        },
      });
      cache.clear();
      cache.set(key, app);
    }
    return app.fetch(normalized);
  },
};
