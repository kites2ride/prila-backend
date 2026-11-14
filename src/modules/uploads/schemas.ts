import { z } from 'zod';

export const presignSchema = z.object({
  folder: z.string().min(1).max(64).default('uploads'),
  contentType: z.string().min(3).max(128),
  extension: z.string().max(16).optional(),
});
