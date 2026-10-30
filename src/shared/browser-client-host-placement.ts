import { z } from 'zod'

export const BrowserClientHostPlacementPreference = z.enum(['auto', 'server'])
export type BrowserClientHostPlacementPreference = z.infer<
  typeof BrowserClientHostPlacementPreference
>

export const BrowserClientHostPlacementPreparationRequest = z.object({
  selector: z.string().min(1),
  expectedPairingRevision: z.number().finite().optional(),
  preference: BrowserClientHostPlacementPreference.default('auto')
})

export type BrowserClientHostPlacementPreparationRequest = z.input<
  typeof BrowserClientHostPlacementPreparationRequest
>

export const BrowserPageCreationPlacement = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server') }),
  z.object({
    kind: z.literal('client'),
    browserHostClientId: z.string().min(1).max(256)
  })
])

export type BrowserPageCreationPlacement = z.infer<typeof BrowserPageCreationPlacement>
