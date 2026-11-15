import { z } from 'zod'
export const WorktreeAdopt = z.object({
  path: z.string().min(1),
  parentWorktree: z.string().min(1)
})
