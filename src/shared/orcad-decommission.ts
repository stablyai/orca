import { z } from 'zod'

export const OrcadDecommissionParamsSchema = z.object({
  version: z.string().min(1).max(255),
  transactionId: z.uuid().optional()
})

export const OrcadDecommissionResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), transactionId: z.uuid().optional() }),
  z.object({
    outcome: z.literal('refused'),
    verdict: z.enum(['live', 'unverifiable']),
    terminalAdmission: z.enum(['open', 'fenced', 'unverifiable']).optional(),
    code: z.string(),
    reason: z.string()
  })
])

export type OrcadDecommissionParams = z.infer<typeof OrcadDecommissionParamsSchema>
export type OrcadDecommissionResult = z.infer<typeof OrcadDecommissionResultSchema>
