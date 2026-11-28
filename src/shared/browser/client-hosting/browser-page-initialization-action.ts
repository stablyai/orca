import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const BrowserPageInitializationAction = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('navigate'), url: z.string().min(1) }),
    z.object({ type: z.literal('stop') })
  ])
)
export type BrowserPageInitializationAction = z.infer<typeof BrowserPageInitializationAction>

export const BrowserPageInitializationActionParams = lazyZodSchema(() =>
  z.object({
    worktree: z.string().min(1),
    page: z.string().min(1).max(256),
    expectedPlacement: z.object({
      kind: z.literal('client'),
      browserHostClientId: z.string().min(1).max(256),
      browserHostGeneration: z.number().int().min(0),
      pageHostGeneration: z.number().int().min(0)
    }),
    action: BrowserPageInitializationAction
  })
)
