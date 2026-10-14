import { betterAuth } from 'better-auth';
import type { DatabaseSync } from 'node:sqlite';
import type { D1Database } from '@cloudflare/workers-types';
import { createAuthEndpoint } from 'better-auth/api';
import { apiKey } from '@better-auth/api-key';
import {
  DEVICE_CODE_GRANT_TYPE,
  getOAuthProviderApi,
  oauthDeviceAuthorization,
  oauthProvider,
} from '@better-auth/oauth-provider';
import type { OAuthOptions } from '@better-auth/oauth-provider';
import { z } from 'zod';

export const connectionMetadata = z.object({
  kind: z.enum(['embed', 'personal']),
  projectId: z.string().nullable(),
  parentOrigin: z.string().nullable(),
});
export type AuthenticationDatabase = DatabaseSync | D1Database;
export interface AuthenticationOptions {
  database: AuthenticationDatabase;
  url: string;
  secret: string;
  github?: { clientId: string; clientSecret: string } | undefined;
  localPassword?: boolean | undefined;
  allowSignup?: boolean | undefined;
}
export function createAuthentication(options: AuthenticationOptions) {
  if (options.secret.length < 32)
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  if (
    options.localPassword &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(options.url).hostname)
  )
    throw new Error('Password sign-in is only available for local development.');
  if (!options.localPassword && !options.github)
    throw new Error('GitHub OAuth credentials are required.');
  const oauthOptions: OAuthOptions<string[]> = {
    rateLimit: { token: { window: 60, max: 120 } },
    scopes: ['feedback:account', 'feedback:project', 'offline_access'],
    enforcePerClientResources: true,
    resources: [
      {
        identifier: `${options.url}/api`,
        allowedScopes: ['feedback:account', 'feedback:project', 'offline_access'],
        accessTokenTtl: 900,
      },
    ],
    grantTypes: [DEVICE_CODE_GRANT_TYPE, 'authorization_code', 'refresh_token'],
    loginPage: '/auth',
    consentPage: '/auth',
    disableJwtPlugin: true,
    storeTokens: 'hashed',
    customAccessTokenClaims: ({ metadata }) => connectionMetadata.parse(metadata),
    customTokenResponseFields: ({ user }) =>
      user
        ? {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              createdAt: user.createdAt.toISOString(),
            },
          }
        : {},
    refreshTokenExpiresIn: 30 * 24 * 60 * 60,
    refreshTokenReuseInterval: 10,
  };
  return betterAuth({
    appName: 'Feedback Toolbar',
    database: options.database,
    baseURL: options.url,
    secret: options.secret,
    trustedOrigins: [options.url],
    emailAndPassword: {
      enabled: options.localPassword === true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
    },
    socialProviders: options.github
      ? { github: { ...options.github, disableSignUp: options.allowSignup === false } }
      : {},
    onAPIError: { errorURL: '/auth' },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 120 },
    advanced: {
      useSecureCookies: options.url.startsWith('https:'),
      ipAddress: { ipAddressHeaders: ['x-feedback-client-ip'] },
    },
    plugins: [
      oauthProvider(oauthOptions),
      oauthDeviceAuthorization({ verificationUri: `${options.url}/auth` }),
      apiKey({
        defaultPrefix: 'fta_',
        maximumNameLength: 80,
        enableMetadata: true,
        keyExpiration: { defaultExpiresIn: 30 * 24 * 60 * 60 * 1000, maxExpiresIn: 30 },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 240 },
      }),
      {
        id: 'feedback-resource-verification',
        endpoints: {
          verifyFeedbackToken: createAuthEndpoint(
            '/feedback/verify-token',
            {
              method: 'POST',
              body: z.object({ token: z.string() }),
              metadata: { SERVER_ONLY: true },
            },
            async (ctx) => {
              const payload = await getOAuthProviderApi(ctx, oauthOptions).requireActiveAccessToken(
                ctx.body.token,
              );
              const client = await getOAuthProviderApi(ctx, oauthOptions).getClient(
                z.string().parse(payload.client_id),
              );
              if (!client?.userId || client.userId !== payload.sub)
                throw new Error('Invalid connection owner.');
              const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
              if (
                !audience.includes(`${options.url}/api`) ||
                payload.iss !== `${options.url}/api/auth` ||
                payload.cnf
              )
                throw new Error('Invalid token audience or issuer.');
              const provider = getOAuthProviderApi(ctx, oauthOptions);
              const tokenRecord = z
                .object({ id: z.string(), clientId: z.string(), userId: z.string() })
                .parse(
                  await ctx.context.adapter.findOne({
                    model: 'oauthAccessToken',
                    where: [
                      {
                        field: 'token',
                        value: await provider.hashToken(ctx.body.token, 'access_token'),
                      },
                    ],
                  }),
                );
              if (tokenRecord.clientId !== payload.client_id || tokenRecord.userId !== payload.sub)
                throw new Error('Invalid token ownership.');
              return { ...payload, client_id: tokenRecord.clientId, tokenId: tokenRecord.id };
            },
          ),
        },
      },
    ],
  });
}
