import { z } from 'zod'
import type { RuntimeEnvironmentReconciliationRecord } from './runtime-environment-reconciliation-record'

const environmentId = z.string().trim().min(1).max(1024)
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const existing = { environmentId, requestId }

export const RuntimeEnvironmentReconciliationRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('prepare'),
      requestId,
      environmentIds: z.tuple([environmentId, environmentId]),
      canonicalEnvironmentId: environmentId
    })
    .refine(
      (value) =>
        value.environmentIds[0] !== value.environmentIds[1] &&
        value.environmentIds.includes(value.canonicalEnvironmentId),
      {
        message: 'Choose two distinct registrations and one of them as canonical.'
      }
    ),
  z.object({ action: z.literal('activate'), ...existing }),
  z.object({ action: z.literal('reverse'), ...existing }),
  z.object({ action: z.literal('cancel'), ...existing })
])

export type RuntimeEnvironmentReconciliationRequest = z.infer<
  typeof RuntimeEnvironmentReconciliationRequestSchema
>
export type RuntimeEnvironmentReconciliationResult = {
  record: RuntimeEnvironmentReconciliationRecord | null
}
