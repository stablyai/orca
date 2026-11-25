import { z } from 'zod'
export const WorktreeAdopt = z.object({
  path: z.string().min(1),
  parentWorktree: z.string().min(1),
  /** The launcher the CLI was invoked as, for the commands Orca's refusals suggest. */
  cliCommand: z.enum(['orca', 'orca-dev', 'orca-ide']).optional()
})
