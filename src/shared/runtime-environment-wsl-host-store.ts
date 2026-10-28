/** WSL host pairing points at the desktop’s wsl.exe stdio bridge; deployment state lives in the WSL store. */
import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'
import {
  readWslHostDeployments,
  writeWslHostDeployment,
  type WslHostDeploymentRecord,
  type WslHostPendingStop
} from './wsl-host-deployment-store'

type WslHostPorts = Pick<WslHostDeploymentRecord, 'localPort' | 'remotePort'>

function parseBridgedPairing(pairingCode: string): PairingOffer {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid WSL host pairing code.')
  }
  return offer
}

function assertPairingUsesBridge(environment: KnownRuntimeEnvironment, localPort: number): void {
  if (getPreferredLoopbackRuntimePort(environment) !== localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The WSL host pairing does not point at its bridge.'
    )
  }
}

export function findWslHostDeployment(
  userDataPath: string,
  environmentId: string
): WslHostDeploymentRecord | null {
  return (
    readWslHostDeployments(userDataPath).deployments.find(
      (record) => record.environmentId === environmentId
    ) ?? null
  )
}

/** Registers a WSL host. Record first: a crash between the writes leaves an ownerless record. */
export function addWslHostEnvironment(
  userDataPath: string,
  args: {
    id: string
    name: string
    pairingCode: string
    record: Omit<WslHostDeploymentRecord, 'environmentId' | 'createdAt'>
    now?: number
  }
): KnownRuntimeEnvironment {
  const offer = parseBridgedPairing(args.pairingCode)
  const known = readEnvironmentStore(userDataPath, { recoverBlankStore: true }).environments
  if (known.some((entry) => entry.id === args.id)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server with id "${args.id}" already exists.`
    )
  }
  const namesake = findCollidingEnvironmentName(known, args.name)
  if (namesake) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${namesake.name}" already exists.`
    )
  }
  const now = args.now ?? Date.now()
  // No connectionDependency: the overlay treats SSH-dependent environments as conflicting.
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now,
    offer,
    runtimeId: null
  })
  assertPairingUsesBridge(environment, args.record.localPort)
  writeWslHostDeployment(userDataPath, args.id, {
    ...args.record,
    environmentId: args.id,
    createdAt: now,
    pairingPublicKeyB64: offer.publicKeyB64
  })
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: [
      ...readPersistedEnvironmentStore(userDataPath, { recoverBlankStore: true }).environments,
      persisted
    ].sort((a, b) => a.name.localeCompare(b.name))
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), args.id)
}

/** Re-pair/move the bridge; return pairing changes so callers retire stale transports. Restarts keep the client grant. */
export function refreshWslHostPairing(
  userDataPath: string,
  environmentId: string,
  args: { pairingCode: string } & WslHostPorts,
  now = Date.now()
): { environment: KnownRuntimeEnvironment; pairingChanged: boolean } {
  const offer = parseBridgedPairing(args.pairingCode)
  const record = findWslHostDeployment(userDataPath, environmentId)
  if (!record) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not a WSL host.')
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const pairingChanged = !samePairing(getPreferredPairingOffer(existing), offer)
  // Validated before any write, so a refused pairing leaves both files as they were.
  const next = pairingChanged
    ? PersistedRuntimeEnvironmentSchema.parse({
        ...createEnvironmentFromPairingOffer({
          id: existing.id,
          name: existing.name,
          now: existing.createdAt,
          offer,
          runtimeId: existing.runtimeId
        }),
        updatedAt: now,
        pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
        lastUsedAt: existing.lastUsedAt
      })
    : null
  if (next) {
    assertPairingUsesBridge(next, args.localPort)
  }
  const keyChanged = record.pairingPublicKeyB64 !== offer.publicKeyB64
  if (record.localPort !== args.localPort || record.remotePort !== args.remotePort || keyChanged) {
    // The previous key keeps the record bound to the old pairing until the write below lands.
    writeWslHostDeployment(userDataPath, environmentId, {
      ...record,
      localPort: args.localPort,
      remotePort: args.remotePort,
      pairingPublicKeyB64: offer.publicKeyB64,
      previousPairingPublicKeyB64: keyChanged
        ? record.pairingPublicKeyB64
        : record.previousPairingPublicKeyB64
    })
  }
  if (next) {
    writeEnvironmentStore(userDataPath, {
      version: 1,
      environments: store.environments.map((candidate) =>
        candidate.id === existing.id ? next : candidate
      )
    })
  }
  return {
    environment: resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId),
    pairingChanged
  }
}

/** Marks (or with null, clears) a Remove that could not prove the host's server stopped. */
export function setWslHostPendingStop(
  userDataPath: string,
  environmentId: string,
  pendingStop: WslHostPendingStop | null
): void {
  const record = findWslHostDeployment(userDataPath, environmentId)
  if (!record) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not a WSL host.')
  }
  const { pendingStop: _previous, ...rest } = record
  writeWslHostDeployment(userDataPath, environmentId, pendingStop ? { ...rest, pendingStop } : rest)
}

/** Environment first: a crash between the writes leaves an ownerless record, never a bare server. */
export function removeWslHostEnvironment(userDataPath: string, environmentId: string): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  if (store.environments.some((entry) => entry.id === environmentId)) {
    writeEnvironmentStore(userDataPath, {
      version: 1,
      environments: store.environments.filter((entry) => entry.id !== environmentId)
    })
  }
  writeWslHostDeployment(userDataPath, environmentId, null)
}

function samePairing(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
}
