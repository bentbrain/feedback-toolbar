import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { installation, originSchema, projectSchema, themeSchema } from '../shared/models.js';
import { bindingKey, client, publicConfig, saveCredential, storedCredentials } from './client.js';
import { installHtml } from './install.js';
import { runWorker } from './worker.js';

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    project: { type: 'string' },
    name: { type: 'string' },
    origin: { type: 'string', multiple: true },
    file: { type: 'string' },
    workspace: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
    once: { type: 'boolean' },
    interval: { type: 'string' },
    runner: { type: 'string' },
    accent: { type: 'string' },
    mode: { type: 'string' },
    placement: { type: 'string' },
    'no-open': { type: 'boolean' },
    'no-agent': { type: 'boolean' },
    agent: { type: 'boolean' },
  },
});
const options = parsed.values;
const command = parsed.positionals[0] ?? 'help';
const output = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};
async function login() {
  const server = originSchema.parse(options.server ?? 'http://localhost:4310');
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const proof = createHash('sha256').update(verifier).digest('base64url');
  const response = await fetch(`${server}/api/auth/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'personal', challenge: proof }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not start login (${response.status}).`);
  const grant = z.object({ id: z.string(), loginUrl: z.string() }).parse(await response.json());
  console.error(`Approve this local connection in your browser:\n${grant.loginUrl}`);
  if (!options['no-open']) {
    const executable =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32'
          : 'xdg-open';
    const args =
      process.platform === 'win32'
        ? ['url.dll,FileProtocolHandler', grant.loginUrl]
        : [grant.loginUrl];
    spawn(executable, args, { stdio: 'ignore' }).on('error', () => {
      console.error('Open the authorization URL above manually.');
    });
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const exchange = await fetch(`${server}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: grant.id, verifier }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (exchange.status === 202) {
      await setTimeout(1500);
      continue;
    }
    if (!exchange.ok) throw new Error('Authorization failed or expired. Run login again.');
    const auth = z
      .object({ token: z.string(), expiresAt: z.number() })
      .parse(await exchange.json());
    await saveCredential(server, auth);
    output({ ok: true, server, expiresAt: auth.expiresAt });
    return;
  }
  throw new Error('Login expired. Run login again.');
}
async function init() {
  const workspace = resolve(options.workspace ?? process.cwd());
  const existing = await publicConfig(workspace);
  const connection = await client({ server: options.server, workspace });
  const requested =
    options.project ?? (existing?.server === connection.server ? existing.projectId : undefined);
  let project;
  if (requested)
    project = z
      .object({ project: projectSchema })
      .parse(await connection.api(`/api/projects/${requested}`)).project;
  else {
    if (!options.name || !options.origin?.length)
      throw new Error(
        'To create a project, pass --name and at least one --origin. To link one, pass --project.',
      );
    const theme = themeSchema.parse({
      ...(options.accent ? { accent: options.accent } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.placement ? { placement: options.placement } : {}),
    });
    const key = createHash('sha256')
      .update(JSON.stringify({ workspace, name: options.name, origins: options.origin }))
      .digest('hex');
    project = z.object({ project: projectSchema }).parse(
      await connection.api('/api/projects', {
        method: 'POST',
        body: { name: options.name, origins: options.origin, theme },
        key,
      }),
    ).project;
  }
  if (options.accent || options.mode || options.placement)
    project = z.object({ project: projectSchema }).parse(
      await connection.api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          theme: themeSchema.parse({
            ...project.theme,
            ...(options.accent ? { accent: options.accent } : {}),
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.placement ? { placement: options.placement } : {}),
          }),
        },
      }),
    ).project;
  const info = installation(project, connection.server);
  const installed = options.file
    ? await installHtml(resolve(workspace, options.file), info.snippet)
    : null;
  await writeFile(
    join(workspace, '.feedback-toolbar.json'),
    JSON.stringify(info.config, null, 2) + '\n',
    { mode: 0o644 },
  );
  const key = bindingKey(connection.server, project.id, workspace);
  if (!options['no-agent']) {
    const saved = (await storedCredentials())[key];
    let connected = false;
    if (saved && saved.expiresAt > Date.now()) {
      try {
        const agent = await client({
          server: connection.server,
          projectId: project.id,
          workspace,
          agent: true,
        });
        await agent.api('/api/me');
        connected = true;
      } catch {
        connected = false;
      }
    }
    if (!connected) {
      const credential = z.object({ token: z.string(), expiresAt: z.number() }).parse(
        await connection.api(`/api/projects/${project.id}/credentials`, {
          method: 'POST',
          body: { name: `Local connector · ${workspace.split('/').at(-1) ?? 'workspace'}` },
        }),
      );
      await saveCredential(key, credential);
    }
  }
  output({
    ...info,
    installed,
    workspace,
    agentConnected: !options['no-agent'],
    next: installed
      ? 'Open your website and sign into the toolbar.'
      : 'Install the returned snippet or module in your shared layout. For HTML files, rerun init with --file.',
  });
}
async function run() {
  if (options.help || command === 'help') {
    console.log(
      `feedback-toolbar\n\n  login --server URL                       Authorize local CLI / MCP access\n  init --name NAME --origin URL --json      Create a project and link this workspace\n  init --project ID --file index.html       Install into an existing HTML project\n  theme --accent '#72865d' --mode dark       Update the linked toolbar's theme\n  doctor                                   Check service, project, and local binding\n  threads                                  Read project feedback as JSON\n  claim                                    Claim one explicitly requested task\n  worker --runner codex [--once]            Run approved feedback tasks in Codex\n  mcp [--agent]                            Serve MCP tools over stdio\n\nOptions: --server, --project, --workspace, --json, --no-agent, --no-open\nSecrets stay in your user configuration directory. Project config contains public values only.`,
    );
    return;
  }
  if (command === 'login') return login();
  if (command === 'init') return init();
  if (command === 'mcp') {
    const { startMcp } = await import('./mcp.js');
    return startMcp({
      server: options.server,
      projectId: options.project,
      workspace: options.workspace,
      agent: options.agent,
    });
  }
  if (command === 'worker')
    return runWorker({
      server: options.server,
      projectId: options.project,
      workspace: options.workspace,
      once: options.once ?? false,
      interval: Number(options.interval ?? 5000),
      runner: options.runner ?? '',
    });
  const connection = await client({
    server: options.server,
    projectId: options.project,
    workspace: options.workspace,
    agent: command === 'claim' || options.agent,
  });
  if (!connection.projectId) throw new Error('Link a project with init, or pass --project.');
  if (command === 'doctor') {
    const project = z
      .object({ project: projectSchema })
      .parse(await connection.api(`/api/projects/${connection.projectId}`)).project;
    const agent = await client({
      server: connection.server,
      projectId: project.id,
      workspace: connection.workspace,
      agent: true,
    });
    await agent.api('/api/me');
    output({
      ok: true,
      server: connection.server,
      projectId: project.id,
      origins: project.origins,
      workspace: connection.workspace,
      agentConnected: true,
    });
    return;
  }
  if (command === 'threads') {
    output(await connection.api(`/api/projects/${connection.projectId}/threads`));
    return;
  }
  if (command === 'claim') {
    output(
      await connection.api(`/api/projects/${connection.projectId}/work/claim`, {
        method: 'POST',
        body: {},
      }),
    );
    return;
  }
  if (command === 'theme') {
    const p = z
      .object({ project: projectSchema })
      .parse(await connection.api(`/api/projects/${connection.projectId}`)).project;
    const theme = themeSchema.parse({
      ...p.theme,
      ...(options.accent ? { accent: options.accent } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.placement ? { placement: options.placement } : {}),
    });
    output(await connection.api(`/api/projects/${p.id}`, { method: 'PATCH', body: { theme } }));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use --help.`);
}
void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Command failed.');
  process.exitCode = 1;
});
