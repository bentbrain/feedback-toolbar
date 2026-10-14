import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { installConfigSchema, originSchema } from '../shared/models.js';
import { readRegularFile, replaceFile } from '../shared/files.js';

const credentialsSchema = z.record(
  z.string(),
  z.object({ token: z.string(), expiresAt: z.number() }),
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
export async function saveCredential(
  key: string,
  credential: { token: string; expiresAt: number },
) {
  const records = await storedCredentials();
  records[key] = credential;
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
  const path = join(directory, 'credentials.json');
  await replaceFile(path, `${JSON.stringify(records, null, 2)}\n`, 0o600);
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
  const auth = process.env.FEEDBACK_TOKEN
    ? { token: process.env.FEEDBACK_TOKEN, expiresAt: Infinity }
    : records[key];
  if (!auth || auth.expiresAt < Date.now())
    throw new Error(
      `Sign in first: feedback-toolbar login --server ${server}${options.agent ? '\nThen run init to create a project-scoped connection for this workspace.' : ''}`,
    );
  const api = async (
    path: string,
    request: { method?: string; body?: unknown; key?: string } = {},
  ) => {
    const response = await fetch(`${server}${path}`, {
      method: request.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
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
