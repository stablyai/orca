import { z } from 'zod'

const id = z.string().min(1)
export const surfaceExecutionProvenanceSchema = z.strictObject({
  platform: z.enum(['linux', 'darwin', 'win32', 'unknown']),
  machineId: id.nullable(),
  kernel: z
    .discriminatedUnion('scheme', [
      z.strictObject({ scheme: z.literal('linux-boot-id-v1'), value: z.uuid() }),
      z.strictObject({ scheme: z.literal('darwin-bootsession-v1'), value: z.uuid() })
    ])
    .nullable()
})
export type SurfaceExecutionProvenance = z.infer<typeof surfaceExecutionProvenanceSchema>

export const surfaceExecutorIdentitySchema = z.object({
  executorId: id,
  provenance: surfaceExecutionProvenanceSchema.nullable().default(null)
})
export type SurfaceExecutorIdentity = z.infer<typeof surfaceExecutorIdentitySchema>

/** A different executor nonce or missing observation says nothing about its predecessor's children. */
export function surfaceExecutionKernelChanged(
  before: SurfaceExecutionProvenance | null | undefined,
  after: SurfaceExecutionProvenance | null | undefined
): boolean {
  return Boolean(
    before?.machineId &&
    before.machineId === after?.machineId &&
    before.platform === after.platform &&
    before.kernel &&
    after.kernel &&
    ((before.platform === 'linux' && before.kernel.scheme === 'linux-boot-id-v1') ||
      (before.platform === 'darwin' && before.kernel.scheme === 'darwin-bootsession-v1')) &&
    before.kernel.scheme === after.kernel.scheme &&
    before.kernel.value !== after.kernel.value
  )
}
