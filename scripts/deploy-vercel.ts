import { verifyPublishedAssets, waitForDeploymentReady } from './release-assets.js';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { readRegularFile } from '../src/shared/files.js';
import { activeServiceOrigin } from '../src/server/proxy-configuration.js';
import { originSchema } from '../src/shared/models.js';

const output = '.vercel/output';
z.object({ version: z.literal(3), routes: z.array(z.unknown()) }).parse(
  JSON.parse((await readRegularFile(`${output}/config.json`)).contents.toString('utf8')),
);
const files: { file: string; data: string; encoding: 'base64' }[] = [];
async function collectFiles(directory: string, prefix: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(path, `${relative}/`);
      continue;
    }
    const opened = await readRegularFile(path);
    files.push({ file: relative, data: opened.contents.toString('base64'), encoding: 'base64' });
  }
}
await collectFiles(output, '.vercel/output/');
if (process.argv.includes('--dry-run')) {
  console.log(
    `Verified prebuilt Vercel payload: ${files.length} built files including the authenticated proxy.`,
  );
} else {
  const token = z.string().min(1).parse(process.env.VERCEL_TOKEN);
  const team = z.string().startsWith('team_').parse(process.env.VERCEL_ORG_ID);
  const project = z.string().startsWith('prj_').parse(process.env.VERCEL_PROJECT_ID);
  const request = async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const query = new URLSearchParams({ teamId: team });
    if (path === '/v13/deployments') query.set('prebuilt', '1');
    if (path.endsWith('/env')) query.set('upsert', 'true');
    const response = await fetch(`https://api.vercel.com${path}?${query}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Vercel API ${path} failed (${response.status}).`);
    return response.json();
  };
  const resolved = z
    .object({ id: z.string(), name: z.string(), accountId: z.string() })
    .parse(await request(`/v9/projects/${project}`));
  if (resolved.id !== project || resolved.accountId !== team)
    throw new Error('Vercel project ownership does not match the deployment target.');
  const proxySecret = z.string().min(32).parse(process.env.FEEDBACK_PROXY_SECRET);
  const apiOrigin = originSchema.parse(process.env.FEEDBACK_API_ORIGIN);
  const serviceOrigin = originSchema.parse(process.env.FEEDBACK_URL);
  const published = await fetch(`${serviceOrigin}/health`, {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  // A provisioned domain returns 404 before its first frontend deployment.
  const previousOrigin =
    published.status === 404
      ? serviceOrigin
      : await activeServiceOrigin(apiOrigin, proxySecret, '127.0.0.1');
  await request(`/v10/projects/${project}/env`, {
    key: 'FEEDBACK_PREVIOUS_URL',
    value: previousOrigin,
    type: 'plain',
    target: ['production'],
  });
  await request(`/v10/projects/${project}/env`, {
    key: 'FEEDBACK_URL',
    value: serviceOrigin,
    type: 'plain',
    target: ['production'],
  });
  await request(`/v10/projects/${project}/env`, {
    key: 'FEEDBACK_PROXY_SECRET',
    value: proxySecret,
    type: 'sensitive',
    target: ['production'],
  });
  await request(`/v10/projects/${project}/env`, {
    key: 'FEEDBACK_API_ORIGIN',
    value: apiOrigin,
    type: 'plain',
    target: ['production'],
  });
  const deploymentSchema = z.object({ id: z.string(), url: z.string(), readyState: z.string() });
  const created = deploymentSchema.parse(
    await request('/v13/deployments', {
      name: resolved.name,
      project,
      target: 'production',
      files,
      projectSettings: {
        framework: null,
        buildCommand: '',
        installCommand: '',
        outputDirectory: null,
        nodeVersion: '24.x',
      },
      meta: { githubCommitSha: process.env.GITHUB_SHA ?? 'manual', githubCommitRef: 'main' },
    }),
  );
  console.log(`Deployment created: https://${created.url}`);
  await waitForDeploymentReady((signal) =>
    request(`/v13/deployments/${created.id}`, undefined, signal),
  );
  await verifyPublishedAssets(
    `${output}/static/assets`,
    originSchema.parse(process.env.FEEDBACK_URL),
    { timeoutMs: 2 * 60_000 },
  );
  console.log(`Production deployment ready and release assets verified: https://${created.url}`);
}
