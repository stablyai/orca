import { z } from 'zod'

export const OrcadManagedStopInstanceSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  nonce: z.string().min(1).max(255),
  lockPath: z.string().min(1).max(4096)
})

export type OrcadManagedStopInstance = z.infer<typeof OrcadManagedStopInstanceSchema>

export function sameOrcadManagedStopInstance(
  left: OrcadManagedStopInstance,
  right: OrcadManagedStopInstance
): boolean {
  return (
    left.pid === right.pid &&
    left.startedAtMs === right.startedAtMs &&
    left.nonce === right.nonce &&
    left.lockPath === right.lockPath
  )
}
