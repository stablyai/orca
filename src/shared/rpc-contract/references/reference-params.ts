import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString, OptionalString } from '../rpc-param-primitives'

export const ReferenceList = lazyZodSchema(() =>
  z.object({
    worktree: requiredString('Missing worktree selector'),
    cwd: OptionalString
  })
)

export const ReferenceFind = lazyZodSchema(() =>
  z
    .object({
      query: requiredString('Missing reference URL or issue key'),
      worktree: OptionalString,
      cwd: OptionalString,
      repo: OptionalString,
      includeArchived: z.boolean().optional(),
      limit: z.number().int().positive().optional()
    })
    .refine((params) => !(params.worktree && params.repo), {
      message: '--repo and --worktree cannot be combined'
    })
)
