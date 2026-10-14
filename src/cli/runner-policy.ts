import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Tool permissions are enforced by the harness, independently of the feedback prompt. */
export function runnerPolicy(workspace: string, runtime: { readablePaths: string[] }) {
  const configuration = [
    'default_permissions="feedback"',
    'approval_policy="never"',
    'permissions.feedback.extends=":workspace"',
    'permissions.feedback.network.enabled=false',
    'shell_environment_policy.inherit="none"',
    `shell_environment_policy.set={ PATH=${JSON.stringify(process.env.PATH ?? '/usr/bin:/bin')}, LANG="en_US.UTF-8", TMPDIR=${JSON.stringify(join(workspace, '.feedback-tmp'))} }`,
    'web_search="disabled"',
  ];
  const denied = [
    '**/.env',
    '**/.env.*',
    '**/*.env',
    '**/*.pem',
    '**/*.key',
    '**/.npmrc',
    '**/.dev.vars',
    '**/.dev.vars.*',
    '.data',
    '.vercel',
    '.wrangler',
    '.feedback-runs',
    '.github',
  ];
  configuration.push(
    `permissions.feedback.filesystem={ ":root"="deny", ":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny", ${JSON.stringify(dirname(process.execPath))}="read", ${JSON.stringify(join(homedir(), '.bun/bin'))}="read", ${runtime.readablePaths.map((path) => `${JSON.stringify(path)}="read"`).join(', ')}, glob_scan_max_depth=8, ":workspace_roots"={ ${denied.map((path) => `${JSON.stringify(path)}="deny"`).join(', ')} } }`,
  );
  const environment: NodeJS.ProcessEnv = { HOME: homedir() };
  for (const key of ['PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return {
    args: [
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--strict-config',
      ...configuration.flatMap((value) => ['-c', value]),
    ],
    environment,
  };
}
