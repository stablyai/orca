import type { SshTarget } from './ssh-types'

/** The runtime id phase-3 builds wrote into `owner` before the fence moved to `orcadFence`. */
const LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX = 'managed-orcad:'

type SshTargetOwner = NonNullable<SshTarget['owner']>

/** The managed Orca server this host serves, or null for a direct SSH host. */
export function getManagedOrcadFenceEnvironmentId(
  target: Pick<SshTarget, 'orcadFence'> | undefined
): string | null {
  return target?.orcadFence?.environmentId || null
}

/** Reads a legacy `owner` fence, only to migrate it to `orcadFence` on load. */
export function getLegacyManagedOrcadOwnerEnvironmentId(
  owner: SshTargetOwner | undefined
): string | null {
  if (!owner?.runtimeId.startsWith(LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX)) {
    return null
  }
  return owner.runtimeId.slice(LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX.length) || null
}

export function isEphemeralRuntimeSshOwner(owner: SshTargetOwner | undefined): boolean {
  return (
    owner?.type === 'on-demand-runtime' && getLegacyManagedOrcadOwnerEnvironmentId(owner) === null
  )
}
