import { z } from 'zod'

export const PrFollowUpsPatch = z
  .object({
    path: z.enum(['enabled', 'events.ciFailed', 'maxAutoRunsPerPr']),
    value: z.union([z.boolean(), z.string(), z.number().int(), z.null()])
  })
  .strict()

export const PrFollowUpsRead = z.object({ worktreeId: z.string().min(1).max(4096).optional() })
export const PrFollowUpsStop = z.object({
  worktreeId: z.string().min(1).max(4096),
  stopped: z.boolean()
})
