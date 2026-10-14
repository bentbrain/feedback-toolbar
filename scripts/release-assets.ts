import { mkdir, readdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { releaseAssetPaths, retrieveReleaseArtifacts } from './release-artifacts.js';
import { originSchema } from '../src/shared/models.js';
import { readRegularFile } from '../src/shared/files.js';

const versionSchema = z.string().regex(/^[a-f0-9]{40}$/);
interface PublicationWait {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
}
function polling(options: PublicationWait, timeoutMs: number, intervalMs: number) {
  const now = options.now ?? (() => performance.now());
  const timeout = z
    .number()
    .int()
    .positive()
    .parse(options.timeoutMs ?? timeoutMs);
  const interval = z
    .number()
    .int()
    .positive()
    .parse(options.intervalMs ?? intervalMs);
  const deadline = now() + timeout;
  return {
    remaining: () => Math.max(0, deadline - now()),
    pause: async () => {
      await (options.pause ?? delay)(Math.min(interval, Math.max(0, deadline - now())));
    },
  };
}
class AssetUnavailable extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`Release asset is unavailable (${status}): ${url}`);
  }
}
function transientAssetFailure(error: unknown) {
  if (error instanceof AssetUnavailable)
    return [404, 408, 429, 500, 502, 503, 504].includes(error.status);
  if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))
    return true;
  if (!(error instanceof TypeError) || !(error.cause instanceof Error) || !('code' in error.cause))
    return false;
  if (typeof error.cause.code !== 'string') return false;
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].includes(error.cause.code);
}
async function download(url: string, wait?: ReturnType<typeof polling>): Promise<Buffer> {
  for (;;) {
    const remaining = wait?.remaining() ?? 30_000;
    if (remaining <= 0) throw new Error(`Release asset propagation timed out: ${url}`);
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.ceil(Math.min(30_000, remaining))),
        cache: 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AssetUnavailable(response.status, url);
      }
      const contents = Buffer.from(await response.arrayBuffer());
      if (wait && wait.remaining() <= 0)
        throw new Error(`Release asset propagation timed out: ${url}`);
      if (contents.length > 8 * 1024 * 1024)
        throw new Error('Release asset exceeds the size limit.');
      return contents;
    } catch (error) {
      if (!wait || !transientAssetFailure(error)) throw error;
      if (wait.remaining() <= 0)
        throw new Error(`Release asset propagation timed out: ${url}`, { cause: error });
      await wait.pause();
    }
  }
}

export async function waitForDeploymentReady(
  read: (signal: AbortSignal) => Promise<unknown>,
  options: PublicationWait = {},
): Promise<void> {
  const wait = polling(options, 8 * 60_000, 3000);
  const state = z.object({
    readyState: z.string(),
    aliasAssigned: z.boolean(),
    aliasError: z.object({ code: z.string(), message: z.string() }).nullish(),
  });
  for (;;) {
    const remaining = wait.remaining();
    if (remaining <= 0)
      throw new Error('Vercel deployment readiness and alias assignment timed out.');
    const deployment = state.parse(await read(AbortSignal.timeout(Math.ceil(remaining))));
    if (wait.remaining() <= 0)
      throw new Error('Vercel deployment readiness and alias assignment timed out.');
    if (deployment.aliasError)
      throw new Error(
        `Vercel alias assignment failed (${deployment.aliasError.code}): ${deployment.aliasError.message}`,
      );
    if (['ERROR', 'CANCELED'].includes(deployment.readyState))
      throw new Error(`Vercel deployment ended with ${deployment.readyState}.`);
    if (deployment.readyState === 'READY' && deployment.aliasAssigned) return;
    await wait.pause();
  }
}

export async function retainActiveAssets(
  directory: string,
  service: string,
  release: string,
  retrieve: (version: string, destination: string) => Promise<void> = retrieveReleaseArtifacts,
) {
  const origin = originSchema.parse(service);
  versionSchema.parse(release);
  const response = await fetch(`${origin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  // A provisioned Vercel domain returns 404 before its first deployment.
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Cannot establish the active release (${response.status}).`);
  const health = z
    .object({ ok: z.literal(true), assetVersion: z.string().nullable() })
    .parse(await response.json());
  const active = health.assetVersion;
  if (active === null) return;
  if (!/^[a-f0-9]{40}$/.test(active)) throw new Error('Invalid active release identifier.');
  if (active === release) return;
  const target = `${directory}/${active}`;
  await mkdir(target, { recursive: true });
  await retrieve(active, target);
}

// Retries are opt-in for a newly published deployment; ordinary verification stays fail-fast.
export async function verifyPublishedAssets(
  directory: string,
  service: string,
  propagation?: PublicationWait,
) {
  const wait = propagation ? polling(propagation, 2 * 60_000, 2000) : undefined;
  const origin = originSchema.parse(service);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const version = versionSchema.parse(entry.name);
    if (!entry.isDirectory()) throw new Error('Invalid release asset directory.');
    for (const asset of await releaseAssetPaths(`${directory}/${version}`)) {
      const expected = (await readRegularFile(`${directory}/${version}/${asset}`)).contents;
      const actual = await download(`${origin}/assets/${version}/${asset}`, wait);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error(`Published release asset differs: ${version}/${asset}`);
    }
  }
}
