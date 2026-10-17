/**
 * Pure pieces the SSH-managed and WSL host stores share when they register or re-pair a server
 * that pairs through a desktop loopback port. Each store keeps its own write order.
 */
import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment
} from './runtime-environments'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-file'

export function parseLoopbackPairingCode(
  pairingCode: string,
  invalidMessage: string
): PairingOffer {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', invalidMessage)
  }
  return offer
}

export function assertNewEnvironmentIdAndName(
  known: readonly Pick<KnownRuntimeEnvironment, 'id' | 'name'>[],
  id: string,
  name: string
): void {
  if (known.some((entry) => entry.id === id)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server with id "${id}" already exists.`
    )
  }
  if (known.some((entry) => entry.name === name)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${name}" already exists.`
    )
  }
}

export function assertPairingUsesLoopbackPort(
  environment: Parameters<typeof getPreferredLoopbackRuntimePort>[0],
  localPort: number,
  mismatchMessage: string
): void {
  if (getPreferredLoopbackRuntimePort(environment) !== localPort) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', mismatchMessage)
  }
}

/** Same endpoint, credentials and paired device: re-pairing to it would change nothing. */
export function isSamePairingOffer(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
}

/**
 * The persisted record after a re-pair: identity, creation and last use kept, and a pairing
 * revision that always moves forward, even when `now` is behind the previous one.
 */
export function repairedPersistedEnvironment(
  existing: PersistedRuntimeEnvironment,
  offer: PairingOffer,
  now: number,
  connectionDependency?: 'ssh-tunnel'
): PersistedRuntimeEnvironment {
  return PersistedRuntimeEnvironmentSchema.parse({
    ...createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId,
      ...(connectionDependency ? { connectionDependency } : {})
    }),
    updatedAt: now,
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    lastUsedAt: existing.lastUsedAt
  })
}

export function withEnvironmentAddedByName(
  environments: readonly PersistedRuntimeEnvironment[],
  added: PersistedRuntimeEnvironment
): PersistedRuntimeEnvironment[] {
  return [...environments, added].sort((a, b) => a.name.localeCompare(b.name))
}

export function withEnvironmentReplaced(
  environments: readonly PersistedRuntimeEnvironment[],
  next: PersistedRuntimeEnvironment
): PersistedRuntimeEnvironment[] {
  return environments.map((candidate) => (candidate.id === next.id ? next : candidate))
}
