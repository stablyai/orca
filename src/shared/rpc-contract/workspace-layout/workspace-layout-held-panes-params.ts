// Paired reopen uses server-owned IDs; requires LAYOUT_REOPEN_HELD_PANES_CAPABILITY.
import { z } from 'zod'

export const LayoutReopenHeldPanesParams = z.object({
  panes: z
    .array(
      z.object({
        worktreeId: z.string().min(1),
        tabId: z.string().min(1),
        leafId: z.string().min(1)
      })
    )
    .min(1)
    .max(1000)
})
