import { z } from 'zod'

import { terminalTabIdSchema } from './terminal-tab-id-schema'

export const terminalSurfaceTombstoneSchema = z.object({
  worktreeId: z.string(),
  parentTabId: terminalTabIdSchema,
  leafId: z.string(),
  ptyId: z.string(),
  incarnationId: z.string().min(1).max(128),
  retiredAt: z.number().finite().nonnegative()
})
