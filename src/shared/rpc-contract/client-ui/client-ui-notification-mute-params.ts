import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const UiSetWorkspaceNotificationMuted = lazyZodSchema(() =>
  z
    .object({
      worktreeId: z.string().min(1),
      muted: z.boolean()
    })
    .strict()
)
