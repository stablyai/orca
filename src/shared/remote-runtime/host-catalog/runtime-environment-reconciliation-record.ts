import { z } from 'zod'

export const RuntimeEnvironmentReconciliationRecordSchema = z.object({
  version: z.literal(1),
  stage: z.enum(['prepared', 'catalog-active']),
  requestId: z.string().min(1),
  canonicalEnvironmentId: z.string().min(1),
  runtimeId: z.string().min(1),
  preparedAt: z.number().finite(),
  registrations: z
    .array(
      z.object({
        environmentId: z.string().min(1),
        authorityDigest: z.string().regex(/^[a-f0-9]{64}$/)
      })
    )
    .length(2)
})

export type RuntimeEnvironmentReconciliationRecord = z.infer<
  typeof RuntimeEnvironmentReconciliationRecordSchema
>

export function assertRuntimeEnvironmentNotReconciling(environment: {
  reconciliation?: unknown
}): void {
  if (environment.reconciliation) {
    throw new Error('Finish or cancel host reconciliation before changing this server lifecycle.')
  }
}
