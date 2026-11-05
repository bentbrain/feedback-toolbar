import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { groupPolicy, parsePolicy, seal, sourceContext } from './core.js';

try {
  const [group, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  const value: unknown = JSON.parse(
    readFileSync(new URL('./policy.json', import.meta.url), 'utf8'),
  );
  const policy = parsePolicy(value);
  const selected = groupPolicy(policy, group);
  const context = sourceContext(policy, group, process.env);
  const metadataEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('TRANSFER_SECRET_')),
  );
  const get = (endpoint: string): unknown => {
    const output: unknown = JSON.parse(
      execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        env: metadataEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return output;
  };
  const branch = z
    .object({ object: z.object({ sha: z.string() }) })
    .parse(get(`repos/${selected.sourceRepository}/git/ref/heads/main`));
  if (branch.object.sha !== context.sha) throw new Error('Source main advanced');
  const history = z
    .object({
      total_count: z.literal(1),
      workflow_runs: z.tuple([z.object({ id: z.number().int().positive() })]),
    })
    .parse(
      get(
        `repos/${selected.sourceRepository}/actions/workflows/sealed-secret-transfer.yml/runs?event=workflow_dispatch&per_page=100`,
      ),
    );
  if (history.workflow_runs[0].id !== context.runId)
    throw new Error('This one-use workflow has a prior dispatch; review before any replacement');
  const manifest = await seal(policy, group, context, process.env);
  const temporary = z.string().min(1).parse(process.env.RUNNER_TEMP);
  const directory = join(temporary, 'sealed-secret-transfer', 'toolbar');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'sealed-transfer.json'), JSON.stringify(manifest) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  // Ciphertext is the only durable output. Never log values or provider errors.
} catch {
  console.error(
    'Sealed-secret transfer failed closed. Review source metadata, fixed policy and required secret names.',
  );
  process.exitCode = 1;
}
