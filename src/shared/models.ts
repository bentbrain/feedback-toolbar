import { z } from 'zod';
import emojiRegex from 'emoji-regex';

export const originSchema = z
  .string()
  .max(300)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Use an exact http(s) origin.' });
      return;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin === 'null' ||
      value !== url.origin
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Use an exact http(s) origin without a path, credentials, or wildcard.',
      });
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      context.addIssue({ code: 'custom', message: 'Public origins must use HTTPS.' });
    }
  });
const colorSchema = z.string().regex(/^#[\da-fA-F]{6}$/, 'Use a six-digit hex color.');
export const themeSchema = z
  .object({
    mode: z.enum(['light', 'dark', 'system']).default('system'),
    accent: colorSchema.default('#0647ff'),
    radius: z.enum(['square', 'soft', 'round']).default('square'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    placement: z.enum(['bottom-right', 'bottom-left']).default('bottom-right'),
  })
  .strict();
export type Theme = z.infer<typeof themeSchema>;
export const defaultTheme = themeSchema.parse({});
export const publicUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  createdAt: z.string(),
});
export const roleSchema = z.enum(['owner', 'member', 'viewer']);
export const memberSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  role: roleSchema,
});
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  origins: z.array(originSchema),
  theme: themeSchema,
  createdAt: z.string(),
  createdBy: z.string(),
  workVersion: z.number().int().nonnegative().optional(),
});
export const projectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    origins: z.array(originSchema).min(1).max(20),
    theme: themeSchema.optional(),
  })
  .strict();
export const credentialSchema = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string().nullable(),
  kind: z.enum(['session', 'personal', 'embed', 'agent']),
  name: z.string(),
  expiresAt: z.number(),
  createdAt: z.string(),
  parentOrigin: z.string().nullable(),
  clientId: z.string().optional(),
  tokenId: z.string().optional(),
  generation: z.number().int().nonnegative().default(0),
});
const anchorSchema = z
  .object({
    selector: z.string().max(700),
    feedbackId: z.string().max(120).nullable(),
    tag: z.string().max(40),
    text: z.string().max(300),
    label: z.string().max(200),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
    }),
  })
  .strict();
export const contextSchema = z
  .object({
    url: z.url().max(1500),
    viewport: z.object({
      width: z.number().int().min(1).max(20000),
      height: z.number().int().min(1).max(20000),
    }),
    deployment: z.string().max(150).nullable(),
    anchor: anchorSchema,
  })
  .strict();
export const emojiSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(new RegExp(`^(?:${emojiRegex().source})(?![\\s\\S])`), 'Use a single emoji.');
const reactionSchema = z.object({
  emoji: emojiSchema,
  actorId: z.string(),
  name: z.string(),
});
const messageSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  author: z.string(),
  kind: z.enum(['human', 'agent']),
  body: z.string(),
  createdAt: z.string(),
  reactions: z.array(reactionSchema),
});
export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  context: contextSchema,
  status: z.enum(['open', 'resolved']),
  messages: z.array(messageSchema),
  messageCount: z.number().int().nonnegative().optional(),
  // Response-only coverage of human comments by the latest frozen work request.
  unsubmittedMessageCount: z.number().int().nonnegative().optional(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const threadInputSchema = z
  .object({ context: contextSchema, body: z.string().trim().min(1).max(8000) })
  .strict();
const evidenceUrl = z
  .url()
  .max(2000)
  .refine((value) => new URL(value).protocol === 'https:', 'Use an HTTPS evidence link.');
export const deliveryInputSchema = z
  .object({
    stage: z.enum(['planning', 'implemented', 'reviewed', 'merged', 'deployed', 'verified']),
    summary: z.string().trim().min(1).max(2000),
    remaining: z.array(z.string().trim().min(1).max(500)).max(50),
    runUrl: z
      .string()
      .max(2000)
      .refine(
        (value) => /^t3-thread:\/\/v1\/[^\s]+$/.test(value) || evidenceUrl.safeParse(value).success,
        'Use a run link.',
      )
      .optional(),
    pullRequestUrl: evidenceUrl.optional(),
    reviewUrl: evidenceUrl.optional(),
    deploymentUrl: evidenceUrl.optional(),
    verificationUrl: evidenceUrl.optional(),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const reviewed = ['reviewed', 'merged', 'deployed', 'verified'].includes(value.stage);
    const merged = ['merged', 'deployed', 'verified'].includes(value.stage);
    const deployed = ['deployed', 'verified'].includes(value.stage);
    if (
      (reviewed && (!value.pullRequestUrl || !value.reviewUrl)) ||
      (merged && !value.commit) ||
      (deployed && !value.deploymentUrl)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Record the PR, review, exact commit and deployment evidence required by this delivery stage.',
      });
    if (
      value.stage === 'verified' &&
      (value.remaining.length ||
        !value.pullRequestUrl ||
        !value.reviewUrl ||
        !value.deploymentUrl ||
        !value.verificationUrl ||
        !value.commit)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Verified delivery requires no remaining work and PR, review, deployment, verification and exact-commit evidence.',
      });
  });
export const jobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  requestedBy: z.string(),
  revision: z.number(),
  snapshot: threadSchema,
  status: z.enum(['queued', 'running', 'review', 'failed', 'cancelled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  leaseHash: z.string().nullable(),
  claimedBy: z.string().nullable(),
  leaseExpiresAt: z.number().nullable(),
  runId: z.string().nullable(),
  result: z.string().nullable(),
  idempotencyKey: z.string(),
  delivery: z.object({ details: deliveryInputSchema, reportedAt: z.string() }).optional(),
  recovery: z
    .object({ inspection: z.string(), resumedAt: z.string(), previousRunId: z.string().nullable() })
    .optional(),
});
export const publicJobSchema = jobSchema
  .omit({
    leaseHash: true,
    snapshot: true,
    idempotencyKey: true,
  })
  .extend({
    attention: z.enum(['unclaimed', 'interrupted', 'remaining', 'unverified']).optional(),
  });
export const eventSchema = z.object({
  seq: z.number(),
  projectId: z.string(),
  actorId: z.string(),
  kind: z.string(),
  resourceId: z.string(),
  createdAt: z.string(),
});
export const installConfigSchema = z
  .object({ server: originSchema, projectId: z.string(), theme: themeSchema.optional() })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type User = z.infer<typeof publicUserSchema>;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

export function installation(project: Project, server: string) {
  const snippet = `<script defer src="${escapeHtml(server)}/embed.js" data-project="${escapeHtml(project.id)}"></script>`;
  return {
    projectId: project.id,
    server,
    snippet,
    module: `import { mountFeedback } from 'feedback-toolbar';\nconst toolbar = mountFeedback({ server: '${server}', projectId: '${project.id}' });`,
    config: { server, projectId: project.id },
    csp: { scriptSrc: server, frameSrc: server, connectSrc: server },
    instructions:
      'Add the script once to the shared HTML layout. For a JavaScript app, use mountFeedback after the page mounts and call destroy on cleanup. Public configuration contains no credentials.',
  };
}
