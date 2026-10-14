import { z } from 'zod';
import { originSchema } from '../shared/models.js';
import { signProxyRequest } from './proxy-signature.js';

// Read the active Worker, including older releases, before enforcing a domain cutover.
export async function activeServiceOrigin(api: string, secret: string, ip: string) {
  const request = new Request(`${originSchema.parse(api)}/api/config`);
  const identity = await signProxyRequest(request, ip, secret);
  const response = await fetch(request, {
    headers: {
      'x-feedback-client-ip': identity.ip,
      'x-feedback-proxy-time': identity.timestamp,
      'x-feedback-proxy-signature': identity.signature,
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Cannot establish the active service origin.');
  return z.object({ url: originSchema }).parse(await response.json()).url;
}
