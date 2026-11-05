import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { z } from 'zod';

const secretName = z.enum([
  'AUTH_GITHUB_CLIENT_SECRET',
  'BETTER_AUTH_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'FEEDBACK_PROXY_SECRET',
  'VERCEL_TOKEN',
]);
const targetSchema = z.strictObject({
  environment: z.enum(['jp-production', 'toolbar-production']),
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  names: z.array(secretName),
});
const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  transferId: z.string().regex(/^[a-zA-Z0-9-]+$/),
  target: z.strictObject({
    repository: z.literal('bentbrain/bent-mono'),
    repositoryId: z.literal(1446488716),
    ownerId: z.literal(28818884),
  }),
  workflowPath: z.literal('.github/workflows/sealed-secret-transfer.yml'),
  ownerId: z.literal(28818884),
  groups: z.strictObject({
    toolbar: z.strictObject({
      sourceRepository: z.literal('bentbrain/feedback-toolbar'),
      sourceRepositoryId: z.literal(1418167129),
      sourceEnvironment: z.literal('production'),
      targets: z.array(targetSchema).length(2),
    }),
  }),
});
type Policy = z.infer<typeof policySchema>;
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export function parsePolicy(value: unknown): Policy {
  return policySchema.parse(value);
}
export function groupPolicy(policy: Policy, group: unknown) {
  z.literal('toolbar').parse(group);
  const selected = policy.groups.toolbar;
  assert.deepEqual(selected.targets.map((target) => target.environment).sort(), [
    'jp-production',
    'toolbar-production',
  ]);
  for (const target of selected.targets) {
    const expected =
      target.environment === 'jp-production' ? ['CLOUDFLARE_API_TOKEN'] : secretName.options;
    assert.deepEqual([...target.names].sort(), [...expected].sort(), 'Unexpected secret allowlist');
  }
  return selected;
}
export function sourceContext(policy: Policy, group: unknown, env: NodeJS.ProcessEnv) {
  const selected = groupPolicy(policy, group);
  const context = z
    .object({
      GITHUB_EVENT_NAME: z.literal('workflow_dispatch'),
      GITHUB_REF: z.literal('refs/heads/main'),
      GITHUB_REF_PROTECTED: z.literal('true'),
      GITHUB_REPOSITORY: z.literal(selected.sourceRepository),
      GITHUB_REPOSITORY_ID: z.literal(String(selected.sourceRepositoryId)),
      GITHUB_REPOSITORY_OWNER_ID: z.literal(String(policy.ownerId)),
      GITHUB_ACTOR_ID: z.literal(String(policy.ownerId)),
      GITHUB_TRIGGERING_ACTOR: z.literal('bentbrain'),
      GITHUB_RUN_ATTEMPT: z.literal('1'),
      GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/),
      GITHUB_RUN_ID: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .transform(Number)
        .pipe(z.number().int().positive()),
      GITHUB_WORKFLOW_REF: z.literal(
        `${selected.sourceRepository}/${policy.workflowPath}@refs/heads/main`,
      ),
    })
    .parse(env);
  return {
    repository: selected.sourceRepository,
    repositoryId: selected.sourceRepositoryId,
    ownerId: policy.ownerId,
    sha: context.GITHUB_SHA,
    runId: context.GITHUB_RUN_ID,
    runAttempt: 1,
    workflowRef: context.GITHUB_WORKFLOW_REF,
  };
}
const secretValue = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 48 * 1024);
const secretInput = z.strictObject({
  AUTH_GITHUB_CLIENT_SECRET: secretValue,
  BETTER_AUTH_SECRET: secretValue,
  CLOUDFLARE_API_TOKEN: secretValue,
  FEEDBACK_PROXY_SECRET: secretValue,
  VERCEL_TOKEN: secretValue,
});
export async function seal(
  policy: Policy,
  group: unknown,
  context: ReturnType<typeof sourceContext>,
  environment: NodeJS.ProcessEnv,
) {
  await sodium.ready;
  const selected = groupPolicy(policy, group);
  const secrets = secretInput.parse(
    Object.fromEntries(
      Object.entries(environment)
        .filter(([name]) => name.startsWith('TRANSFER_SECRET_'))
        .map(([name, value]) => [name.slice('TRANSFER_SECRET_'.length), value]),
    ),
  );
  const records = [];
  for (const target of selected.targets) {
    const key = sodium.from_base64(target.publicKey, sodium.base64_variants.ORIGINAL);
    assert.equal(key.length, sodium.crypto_box_PUBLICKEYBYTES, 'Invalid target key');
    for (const name of target.names) {
      const plaintext = sodium.from_string(secrets[name]);
      try {
        records.push({
          name,
          environment: target.environment,
          keyId: target.keyId,
          publicKeySha256: hash(key),
          encryptedValue: sodium.to_base64(
            sodium.crypto_box_seal(plaintext, key),
            sodium.base64_variants.ORIGINAL,
          ),
        });
      } finally {
        sodium.memzero(plaintext);
      }
    }
  }
  return {
    schemaVersion: 1,
    transferId: policy.transferId,
    policySha256: hash(JSON.stringify(policy)),
    group: 'toolbar',
    source: context,
    target: policy.target,
    records,
  };
}
