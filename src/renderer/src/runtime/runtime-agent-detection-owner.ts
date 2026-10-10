import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

export type RuntimeAgentDetectionOwner = {
  environmentId: string
  pairingRevision?: number
}

export function captureRuntimeAgentDetectionOwner(
  environments: readonly PublicKnownRuntimeEnvironment[] | undefined,
  environmentId: string,
  expectedPairingRevision?: number
): RuntimeAgentDetectionOwner {
  const environment = environments?.find((entry) => entry.id === environmentId)
  return {
    environmentId,
    pairingRevision:
      expectedPairingRevision ?? environment?.pairingRevision ?? environment?.createdAt
  }
}

export function runtimeAgentDetectionOwnerKey(owner: RuntimeAgentDetectionOwner): string {
  return JSON.stringify([owner.environmentId, owner.pairingRevision ?? null])
}

export function runtimeAgentDetectionOwnerIsCurrent(
  environments: readonly PublicKnownRuntimeEnvironment[] | undefined,
  owner: RuntimeAgentDetectionOwner
): boolean {
  return (
    runtimeAgentDetectionOwnerKey(
      captureRuntimeAgentDetectionOwner(environments, owner.environmentId)
    ) === runtimeAgentDetectionOwnerKey(owner)
  )
}

export function runtimeAgentDetectionCacheMatchesOwner(
  cachedOwnerKey: string | undefined,
  owner: RuntimeAgentDetectionOwner
): boolean {
  return (
    cachedOwnerKey === runtimeAgentDetectionOwnerKey(owner) ||
    (cachedOwnerKey === undefined && owner.pairingRevision === undefined)
  )
}
