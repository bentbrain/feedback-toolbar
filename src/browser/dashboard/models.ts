import { z } from 'zod';
import { memberSchema, projectSchema, publicUserSchema } from '../../shared/models.js';

export const projectListSchema = z.array(projectSchema.extend({ role: z.string() }));
export const memberListSchema = z.array(memberSchema.extend({ user: publicUserSchema }));
export const agentListSchema = z.array(
  z.object({ id: z.string(), name: z.string(), expiresAt: z.number(), createdAt: z.string() }),
);
export type Account = z.infer<typeof publicUserSchema>;
export type ProjectWithRole = z.infer<typeof projectListSchema>[number];
