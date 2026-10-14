import { z } from 'zod';
import { originSchema, publicUserSchema } from './models.js';

export const deviceConnectionSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri_complete: z.url(),
  expires_in: z.number(),
  interval: z.number(),
  clientId: z.string(),
});
export const connectionSchema = z.object({
  token: z.string(),
  refreshToken: z.string(),
  clientId: z.string(),
  expiresAt: z.number(),
  user: publicUserSchema.optional(),
});
const oauthResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  user: publicUserSchema.optional(),
});
export class ConnectionError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}
export async function exchangeConnection(
  server: string,
  clientId: string,
  grant: { deviceCode: string } | { refreshToken: string },
) {
  const origin = originSchema.parse(server);
  const response = await fetch(`${origin}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      client_id: clientId,
      resource: `${origin}/api`,
      ...('deviceCode' in grant
        ? {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: grant.deviceCode,
          }
        : { grant_type: 'refresh_token', refresh_token: grant.refreshToken }),
    }),
  });
  const data: unknown = await response.json();
  if (response.status === 429) return { pending: true, slowDown: true };
  if (!response.ok) {
    const error = z
      .object({ error: z.string(), error_description: z.string().optional() })
      .safeParse(data);
    if (error.success && ['authorization_pending', 'slow_down'].includes(error.data.error))
      return { pending: true, slowDown: error.data.error === 'slow_down' };
    throw new ConnectionError(
      error.success
        ? (error.data.error_description ?? error.data.error)
        : 'Connection failed. Try again.',
      [400, 401, 403].includes(response.status) &&
        (!error.success || !['server_error', 'temporarily_unavailable'].includes(error.data.error)),
    );
  }
  const result = oauthResponseSchema.parse(data);
  return {
    pending: false,
    connection: connectionSchema.parse({
      token: result.access_token,
      refreshToken: result.refresh_token,
      clientId,
      expiresAt: Date.now() + result.expires_in * 1000,
      ...(result.user ? { user: result.user } : {}),
    }),
  };
}
export async function revokeConnection(server: string, clientId: string, refreshToken: string) {
  const origin = originSchema.parse(server);
  const response = await fetch(`${origin}/api/auth/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      client_id: clientId,
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
  });
  if (!response.ok) throw new Error('Connection could not be revoked. Try again.');
}
