import { z } from 'zod'

export const MobileWebNavigationRoutePayloadSchema = z
  .object({
    destination: z.enum(['hostPicker', 'pairingRepair', 'terminalSettings', 'connectionLog'])
  })
  .strict()

export const MobileWebNavigationReconnectPayloadSchema = z.object({}).strict()

export const MobileWebNavigationRemoveHostPayloadSchema = z
  .object({
    confirmation: z.literal('remove-paired-host')
  })
  .strict()

export const MobileWebNavigationResultSchema = z.null()

export type MobileWebNavigationRoutePayload = z.infer<typeof MobileWebNavigationRoutePayloadSchema>
export type MobileWebNavigationRemoveHostPayload = z.infer<
  typeof MobileWebNavigationRemoveHostPayloadSchema
>
