import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readRegularFile } from '../src/shared/files.js';

const output = '.vercel/output';
const config = z
  .object({ version: z.literal(3), routes: z.array(z.unknown()) })
  .parse(JSON.parse((await readRegularFile(`${output}/config.json`)).contents.toString('utf8')));
const files: { file: string; data: string; encoding: 'base64' }[] = [];
for (const name of await readdir(`${output}/static`)) {
  const path = `${output}/static/${name}`;
  const opened = await readRegularFile(path);
  files.push({ file: name, data: opened.contents.toString('base64'), encoding: 'base64' });
}
// This project serves only static assets and proxies dynamic requests to the Worker.
// The API uploads these tested assets without installing framework builders or rebuilding source.
files.push({
  file: 'vercel.json',
  encoding: 'base64',
  data: Buffer.from(JSON.stringify({ version: 2, routes: config.routes })).toString('base64'),
});
if (process.argv.includes('--dry-run')) {
  console.log(`Verified Vercel deployment payload: ${files.length} built files.`);
} else {
  const token = z.string().min(1).parse(process.env.VERCEL_TOKEN);
  const team = z.string().startsWith('team_').parse(process.env.VERCEL_ORG_ID);
  const project = z.string().startsWith('prj_').parse(process.env.VERCEL_PROJECT_ID);
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(
      `https://api.vercel.com${path}?teamId=${encodeURIComponent(team)}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new Error(`Vercel API ${path} failed (${response.status}).`);
    const data: unknown = await response.json();
    return data;
  };
  const resolved = z
    .object({ id: z.string(), name: z.string(), accountId: z.string() })
    .parse(await request(`/v9/projects/${project}`));
  if (resolved.id !== project || resolved.accountId !== team)
    throw new Error('Vercel project ownership does not match the configured deployment target.');
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
      },
      meta: { githubCommitSha: process.env.GITHUB_SHA ?? 'manual', githubCommitRef: 'main' },
    }),
  );
  console.log(`Deployment created: https://${created.url}`);
  const deadline = Date.now() + 8 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const deployment = deploymentSchema.parse(await request(`/v13/deployments/${created.id}`));
    if (deployment.readyState === 'READY') {
      ready = true;
      break;
    }
    if (['ERROR', 'CANCELED'].includes(deployment.readyState))
      throw new Error(`Vercel deployment ended with ${deployment.readyState}.`);
    await delay(3000);
  }
  if (!ready) throw new Error('Vercel deployment did not become ready within eight minutes.');
  console.log(`Production deployment ready: https://${created.url}`);
}
