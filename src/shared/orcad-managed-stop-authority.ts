import { z } from 'zod'

export const OrcadManagedStopRuntimeIdentitySchema = z.object({
  runtimeId: z.string().min(1).max(255),
  profileId: z.string().min(1).max(255),
  profileRoot: z.string().min(1).max(4096)
})

export const OrcadManagedStopAuthoritySchema = OrcadManagedStopRuntimeIdentitySchema.extend({
  transactionId: z.uuid()
})

export type OrcadManagedStopRuntimeIdentity = z.infer<typeof OrcadManagedStopRuntimeIdentitySchema>
export type OrcadManagedStopAuthority = z.infer<typeof OrcadManagedStopAuthoritySchema>

export function sameOrcadManagedStopAuthority(
  left: OrcadManagedStopAuthority,
  right: OrcadManagedStopAuthority
): boolean {
  return (
    left.runtimeId === right.runtimeId &&
    left.profileId === right.profileId &&
    left.profileRoot === right.profileRoot &&
    left.transactionId === right.transactionId
  )
}
