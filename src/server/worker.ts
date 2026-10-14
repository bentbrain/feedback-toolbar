import type { D1Database } from '@cloudflare/workers-types';
import { createApp } from './app.js';
import { d1Store } from './d1-store.js';
import { originSchema } from '../shared/models.js';
import demo from '../../public/demo.html';

interface Bindings {
  DB: D1Database;
  FEEDBACK_URL: string;
  DEMO_URL?: string;
  FEEDBACK_ALLOW_SIGNUP?: string;
}
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
    const normalized = new Request(`${url}${incoming.pathname}${incoming.search}`, request);
    const app = createApp({
      store: d1Store(env.DB),
      url,
      demoUrl: env.DEMO_URL ?? `${incoming.origin}/example`,
      allowSignup: env.FEEDBACK_ALLOW_SIGNUP !== 'false',
    });
    return app.fetch(normalized);
  },
};
