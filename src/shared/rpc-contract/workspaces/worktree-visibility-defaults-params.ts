import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../worktree/visibility/visibility-sources'

export const WorktreeVisibilityDefaultsUpdate = lazyZodSchema(() =>
  z
    .object({
      external: z.enum(['hide', 'show']).optional(),
      customSources: z
        .unknown()
        .transform((value) => normalizeCustomWorktreeVisibilitySources(value))
        .optional(),
      sourcePreferences: z
        .unknown()
        .transform((value) => normalizeWorktreeVisibilitySourcePreferences(value))
        .optional()
    })
    .strict()
)
