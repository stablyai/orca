import { z } from 'zod'
import {
  OrcadManagedStopAuthoritySchema,
  OrcadManagedStopRuntimeIdentitySchema
} from './orcad-managed-stop-authority'
import { OrcadDecommissionResultSchema } from './orcad-decommission'
import { OrcadManagedStopInstanceSchema } from './orcad-managed-stop-instance'

export const OrcadManagedStopIdentitySchema = z.object({
  version: z.string().min(1).max(255),
  identity: OrcadManagedStopRuntimeIdentitySchema,
  instance: OrcadManagedStopInstanceSchema.optional(),
  completedStopReceipt: z.literal(1).optional(),
  cancelPreparedStop: z.literal(1).optional()
})

export const OrcadManagedDecommissionParamsSchema = z.object({
  version: z.string().min(1).max(255),
  authority: OrcadManagedStopAuthoritySchema
})

export const OrcadManagedDecommissionResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    transactionId: z.uuid(),
    authority: OrcadManagedStopAuthoritySchema
  }),
  OrcadDecommissionResultSchema.options[1]
])

export type OrcadManagedDecommissionParams = z.infer<typeof OrcadManagedDecommissionParamsSchema>
export type OrcadManagedDecommissionResult = z.infer<typeof OrcadManagedDecommissionResultSchema>
