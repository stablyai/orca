/**
 * The runtime environment behind a WSL host (C7): a plain paired environment whose pairing points
 * at the desktop end of the `wsl.exe` stdio bridge, plus its record in the WSL deployment store.
 */
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment
} from './runtime-environments'
import {
  assertNewEnvironmentIdAndName,
  assertPairingUsesLoopbackPort,
  isSamePairingOffer,
  parseLoopbackPairingCode,
  repairedPersistedEnvironment,
  withEnvironmentAddedByName,
  withEnvironmentReplaced
} from './runtime-environment-pairing-record'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import {
  readWslHostDeployments,
  writeWslHostDeployment,
  type WslHostDeploymentRecord
} from './wsl-host-deployment-store'

type WslHostPorts = Pick<WslHostDeploymentRecord, 'localPort' | 'remotePort'>

const INVALID_WSL_PAIRING = 'Invalid WSL host pairing code.'
const WSL_PORT_MISMATCH = 'The WSL host pairing does not point at its bridge.'

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
  const offer = parseLoopbackPairingCode(args.pairingCode, INVALID_WSL_PAIRING)
  assertNewEnvironmentIdAndName(readEnvironmentStore(userDataPath).environments, args.id, args.name)
  const now = args.now ?? Date.now()
  // No connectionDependency: the overlay treats SSH-dependent environments as conflicting.
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now,
    offer,
    runtimeId: null
  })
  assertPairingUsesLoopbackPort(environment, args.record.localPort, WSL_PORT_MISMATCH)
  writeWslHostDeployment(userDataPath, args.id, {
    ...args.record,
    environmentId: args.id,
    createdAt: now
  })
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: withEnvironmentAddedByName(
      readPersistedEnvironmentStore(userDataPath).environments,
      persisted
    )
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), args.id)
}

/**
 * Keeps a WSL host's pairing and ports current after orcad relaunched (a new device token) or
 * the bridge moved. Returns whether the pairing changed, so callers retire stale transports.
 */
export function refreshWslHostPairing(
  userDataPath: string,
  environmentId: string,
  args: { pairingCode: string } & WslHostPorts,
  now = Date.now()
): { environment: KnownRuntimeEnvironment; pairingChanged: boolean } {
  const offer = parseLoopbackPairingCode(args.pairingCode, INVALID_WSL_PAIRING)
  const record = findWslHostDeployment(userDataPath, environmentId)
  if (!record) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not a WSL host.')
  }
  if (record.localPort !== args.localPort || record.remotePort !== args.remotePort) {
    writeWslHostDeployment(userDataPath, environmentId, {
      ...record,
      localPort: args.localPort,
      remotePort: args.remotePort
    })
  }
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
  if (isSamePairingOffer(getPreferredPairingOffer(current), offer)) {
    return { environment: current, pairingChanged: false }
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const next = repairedPersistedEnvironment(existing, offer, now)
  assertPairingUsesLoopbackPort(next, args.localPort, WSL_PORT_MISMATCH)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: withEnvironmentReplaced(store.environments, next)
  })
  return {
    environment: resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId),
    pairingChanged: true
  }
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
