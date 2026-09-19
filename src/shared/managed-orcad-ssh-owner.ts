import type { SshTarget } from './ssh-types'

const MANAGED_ORCAD_RUNTIME_ID_PREFIX = 'managed-orcad:'

type SshTargetOwner = NonNullable<SshTarget['owner']>

export function createManagedOrcadSshOwner(environmentId: string): SshTargetOwner {
  return {
    type: 'on-demand-runtime',
    runtimeId: `${MANAGED_ORCAD_RUNTIME_ID_PREFIX}${environmentId}`
  }
}

export function getManagedOrcadOwnerEnvironmentId(
  owner: SshTargetOwner | undefined
): string | null {
  if (owner?.type === 'orcad-runtime') {
    return owner.environmentId
  }
  if (owner?.type !== 'on-demand-runtime') {
    return null
  }
  const environmentId = owner.runtimeId.startsWith(MANAGED_ORCAD_RUNTIME_ID_PREFIX)
    ? owner.runtimeId.slice(MANAGED_ORCAD_RUNTIME_ID_PREFIX.length)
    : ''
  return environmentId || null
}

export function isEphemeralRuntimeSshOwner(owner: SshTargetOwner | undefined): boolean {
  return owner?.type === 'on-demand-runtime' && getManagedOrcadOwnerEnvironmentId(owner) === null
}
