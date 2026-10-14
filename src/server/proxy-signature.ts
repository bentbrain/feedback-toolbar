import { isIP } from 'node:net';

async function key(secret: string) {
  if (secret.length < 32) throw new Error('Configure a private proxy signing secret.');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
function payload(request: Request, ip: string, timestamp: string) {
  const url = new URL(request.url);
  return new TextEncoder().encode(
    `${request.method}\n${url.pathname}${url.search}\n${ip}\n${timestamp}`,
  );
}
export async function signProxyRequest(request: Request, ip: string, secret: string) {
  if (!isIP(ip)) throw new Error('Missing trusted visitor IP.');
  const timestamp = Date.now().toString();
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    payload(request, ip, timestamp),
  );
  return { ip, timestamp, signature: Buffer.from(signature).toString('hex') };
}
export async function verifiedProxyIp(request: Request, secret: string): Promise<string | null> {
  const ip = request.headers.get('x-feedback-client-ip') ?? '';
  const timestamp = request.headers.get('x-feedback-proxy-time') ?? '';
  const signature = request.headers.get('x-feedback-proxy-signature') ?? '';
  if (
    !isIP(ip) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await key(secret),
    new Uint8Array(Buffer.from(signature, 'hex')),
    payload(request, ip, timestamp),
  );
  return valid ? ip : null;
}
