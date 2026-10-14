import { getRequestListener } from '@hono/node-server';
import { originSchema } from '../shared/models.js';
import { signProxyRequest } from './proxy-signature.js';
import { activeServiceOrigin } from './proxy-configuration.js';

async function proxy(request: Request): Promise<Response> {
  try {
    const api = originSchema.parse(process.env.FEEDBACK_API_ORIGIN);
    const path = new URL(request.url);
    const secret = process.env.FEEDBACK_PROXY_SECRET;
    if (!secret) throw new Error('Proxy signing is not configured.');
    const visitor = request.headers.get('x-vercel-forwarded-for') ?? '';
    // Health has no account data or mutations and must stay reachable on deployment aliases.
    if (!(path.pathname === '/health' && ['GET', 'HEAD'].includes(request.method))) {
      const active = await activeServiceOrigin(api, secret, visitor);
      const configured = [
        originSchema.parse(process.env.FEEDBACK_URL),
        originSchema.parse(process.env.FEEDBACK_PREVIOUS_URL),
      ];
      const service = configured.find((origin) => origin === active);
      if (!service) throw new Error('The Worker uses an unregistered service origin.');
      // TLS ends at Vercel. Match its client Host, not the internal socket's scheme.
      if (path.host !== new URL(service).host) {
        if (['GET', 'HEAD'].includes(request.method))
          return Response.redirect(`${service}${path.pathname}${path.search}`, 307);
        return Response.json({ error: 'Use the configured service URL.' }, { status: 403 });
      }
      if (path.pathname === '/example')
        return Response.redirect(`${api}/example${path.search}`, 307);
    }
    const headers = new Headers();
    for (const name of [
      'accept',
      'authorization',
      'cookie',
      'content-type',
      'idempotency-key',
      'origin',
      'sec-fetch-site',
      'sec-fetch-mode',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Vercel overwrites this platform header. Browser-supplied identity headers are never forwarded.
    const identity = await signProxyRequest(
      request,
      request.headers.get('x-vercel-forwarded-for') ?? '',
      secret,
    );
    headers.set('x-feedback-client-ip', identity.ip);
    headers.set('x-feedback-proxy-time', identity.timestamp);
    headers.set('x-feedback-proxy-signature', identity.signature);
    let body: ArrayBuffer | undefined;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const reader = request.body?.getReader();
      const pieces: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 32_768) {
            await reader.cancel();
            return Response.json({ error: 'Request is too large.' }, { status: 413 });
          }
          pieces.push(part.value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const piece of pieces) {
        bytes.set(piece, offset);
        offset += piece.length;
      }
      body = bytes.buffer;
    }
    const upstream = await fetch(`${api}${path.pathname}${path.search}`, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const responseHeaders = new Headers(upstream.headers);
    // Fetch decodes upstream compression; forwarding those encodings would make browsers decode twice.
    for (const name of [
      'content-encoding',
      'content-length',
      'transfer-encoding',
      'connection',
      'keep-alive',
    ])
      responseHeaders.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json(
      { error: 'The feedback service is unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export default getRequestListener(proxy);
