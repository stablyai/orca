import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// 'client' is the person moving one page here: it skips the global setting, never the server's capabilities.
export const BrowserClientHostPlacementPreference = lazyZodSchema(() =>
  z.enum(['auto', 'server', 'client'])
)
export type BrowserClientHostPlacementPreference = z.infer<
  typeof BrowserClientHostPlacementPreference
>

export const BrowserClientHostPlacementPreparationRequest = lazyZodSchema(() =>
  z.object({
    selector: z.string().min(1),
    expectedPairingRevision: z.number().finite().optional(),
    preference: BrowserClientHostPlacementPreference.default('auto')
  })
)

export type BrowserClientHostPlacementPreparationRequest = z.input<
  typeof BrowserClientHostPlacementPreparationRequest
>

export const BrowserPageCreationPlacement = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('server') }),
    z.object({
      kind: z.literal('client'),
      browserHostClientId: z.string().min(1).max(256)
    })
  ])
)

export type BrowserPageCreationPlacement = z.infer<typeof BrowserPageCreationPlacement>
