import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lock } from 'proper-lockfile';
import { installConfigSchema, originSchema } from '../shared/models.js';
import { readRegularFile, replaceFile } from '../shared/files.js';
import { exchangeConnection } from '../shared/oauth.js';

const credentialsSchema = z.record(
  z.string(),
  z.object({
    token: z.string(),
    expiresAt: z.number(),
    refreshToken: z.string().optional(),
    clientId: z.string().optional(),
  }),
);
const directory = process.env.FEEDBACK_CONFIG_DIR ?? join(homedir(), '.config', 'feedback-toolbar');
export const bindingKey = (server: string, projectId: string, workspace: string) =>
  `agent:${createHash('sha256')
    .update(`${server}:${projectId}:${resolve(workspace)}`)
    .digest('hex')}`;
export async function storedCredentials() {
  try {
    const path = join(directory, 'credentials.json');
    return credentialsSchema.parse(
      JSON.parse((await readRegularFile(path)).contents.toString('utf8')),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}
async function writeCredential(
  key: string,
  credential: {
    token: string;
    expiresAt: number;
    refreshToken?: string | undefined;
    clientId?: string | undefined;
  },
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await folder.chmod(0o700);
  } finally {
    await folder.close();
  }
  const records = await storedCredentials();
  records[key] = credential;
  const path = join(directory, 'credentials.json');
  await replaceFile(path, `${JSON.stringify(records, null, 2)}\n`, 0o600);
}
async function lockedCredentials<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await folder.chmod(0o700);
  } finally {
    await folder.close();
  }
  const release = await lock(directory, {
    lockfilePath: join(directory, '.credentials.lock'),
    stale: 30_000,
    retries: { retries: 350, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
export async function saveCredential(
  key: string,
  credential: {
    token: string;
    expiresAt: number;
    refreshToken?: string | undefined;
    clientId?: string | undefined;
  },
) {
  await lockedCredentials(() => writeCredential(key, credential));
}
async function refreshCredential(server: string, key: string) {
  return lockedCredentials(async () => {
    const latest = (await storedCredentials())[key];
    if (!latest) throw new Error('Sign in again.');
    if (latest.expiresAt >= Date.now() + 60_000) return latest;
    if (!latest.refreshToken || !latest.clientId) throw new Error('Reconnect this credential.');
    const result = await exchangeConnection(server, latest.clientId, {
      refreshToken: latest.refreshToken,
    });
    if (!result.connection) throw new Error('Sign in again.');
    await writeCredential(key, result.connection);
    return result.connection;
  });
}
export async function publicConfig(workspace = process.cwd()) {
  try {
    return installConfigSchema.parse(
      JSON.parse(
        (await readRegularFile(join(workspace, '.feedback-toolbar.json'))).contents.toString(
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function client(
  options: {
    server?: string | undefined;
    projectId?: string | undefined;
    workspace?: string | undefined;
    agent?: boolean | undefined;
  } = {},
) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const config = await publicConfig(workspace);
  const server = originSchema.parse(
    options.server ?? config?.server ?? process.env.FEEDBACK_SERVER ?? 'http://localhost:4310',
  );
  const projectId = options.projectId ?? config?.projectId;
  const records = await storedCredentials();
  const key = options.agent && projectId ? bindingKey(server, projectId, workspace) : server;
  let auth = process.env.FEEDBACK_TOKEN
    ? { token: process.env.FEEDBACK_TOKEN, expiresAt: Infinity }
    : records[key];
  if (auth && auth.expiresAt < Date.now() + 60_000 && auth.refreshToken && auth.clientId) {
    auth = await refreshCredential(server, key);
  }
  if (!auth || auth.expiresAt < Date.now())
    throw new Error(
      `Sign in first: feedback-toolbar login --server ${server}${options.agent ? '\nThen run init to create a project-scoped connection for this workspace.' : ''}`,
    );
  let credential = auth;
  let renewal: Promise<void> | null = null;
  const api = async (
    path: string,
    request: { method?: string; body?: unknown; key?: string } = {},
  ) => {
    if (
      credential.expiresAt < Date.now() + 60_000 &&
      credential.clientId &&
      credential.refreshToken
    ) {
      renewal ??= refreshCredential(server, key)
        .then((next) => {
          credential = next;
        })
        .finally(() => {
          renewal = null;
        });
      await renewal;
    }
    const response = await fetch(`${server}${path}`, {
      method: request.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
        ...(request.key ? { 'Idempotency-Key': request.key } : {}),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const result = z.object({ error: z.string() }).safeParse(data);
      throw new Error(
        result.success ? result.data.error : `Feedback request failed (${response.status}).`,
      );
    }
    return data;
  };
  return { server, projectId, workspace, api };
}
