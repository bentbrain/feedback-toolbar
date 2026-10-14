import { getRequestListener } from '@hono/node-server';
import { originSchema } from '../shared/models.js';
import { signProxyRequest } from './proxy-signature.js';

async function proxy(request: Request): Promise<Response> {
  try {
    const api = originSchema.parse(process.env.FEEDBACK_API_ORIGIN);
    const path = new URL(request.url);
    if (path.pathname === '/example') return Response.redirect(`${api}/example${path.search}`, 307);
    const headers = new Headers();
    for (const name of [
      'accept',
      'authorization',
      'cookie',
      'content-type',
      'origin',
      'sec-fetch-site',
      'sec-fetch-mode',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const secret = process.env.FEEDBACK_PROXY_SECRET;
    if (!secret) throw new Error('Proxy signing is not configured.');
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
