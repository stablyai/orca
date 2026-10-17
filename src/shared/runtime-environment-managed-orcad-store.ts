import {
  createEnvironmentFromPairingOffer,
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type OrcadSshDeploymentLink
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
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import { resolveEnvironmentFromStore } from './runtime-environment-store'

const INVALID_MANAGED_PAIRING = 'Invalid managed pairing code.'
const MANAGED_PORT_MISMATCH = 'The managed pairing does not point at its SSH tunnel.'

/** Registers a server Orca deployed over SSH, paired through its own loopback tunnel. */
export function addManagedOrcadEnvironment(
  userDataPath: string,
  args: {
    id: string
    name: string
    pairingCode: string
    orcadDeployment: OrcadSshDeploymentLink
    now?: number
  }
): KnownRuntimeEnvironment {
  const offer = parseLoopbackPairingCode(args.pairingCode, INVALID_MANAGED_PAIRING)
  assertNewEnvironmentIdAndName(readEnvironmentStore(userDataPath).environments, args.id, args.name)
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now: args.now ?? Date.now(),
    offer,
    runtimeId: null,
    connectionDependency: 'ssh-tunnel'
  })
  assertPairingUsesLoopbackPort(environment, args.orcadDeployment.localPort, MANAGED_PORT_MISMATCH)
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  const environments = withEnvironmentAddedByName(
    readPersistedEnvironmentStore(userDataPath).environments,
    persisted
  )
  // Sidecar first: a crash between the writes leaves an ownerless entry the next write prunes,
  // never a registered server that has lost its deployment link.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, persisted, {
    orcadDeployment: args.orcadDeployment
  })
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  const registered = readEnvironmentStore(userDataPath).environments.find(
    (entry) => entry.id === args.id
  )
  if (!registered?.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      'The managed server was saved without its deployment link.'
    )
  }
  return registered
}

/**
 * Unlinks a managed server once its orcad is proven to have exited: drops the persisted entry
 * and the sidecar record that held its deployment link.
 */
export function removeManagedOrcadEnvironment(userDataPath: string, environmentId: string): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  // Throws before the store write when the entry is unreadable, so its link is never orphaned.
  readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  const remaining = store.environments.filter((entry) => entry.id !== persisted.id)
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, remaining, persisted, null)
}

/** Keeps a managed server's pairing current after its orcad changed versions. */
export function refreshManagedOrcadPairing(
  userDataPath: string,
  environmentId: string,
  pairingCode: string,
  now = Date.now()
): KnownRuntimeEnvironment {
  const offer = parseLoopbackPairingCode(pairingCode, INVALID_MANAGED_PAIRING)
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
  if (!current.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const deployment = getOrcadSshDeployment(current)
  if (!deployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This server is not managed over SSH.'
    )
  }
  // Why skip: orcad keeps its pairing state across versions, so an unchanged offer needs no
  // rewrite, and every rewrite re-binds the sidecar entry.
  if (isSamePairingOffer(getPreferredPairingOffer(current), offer)) {
    return current
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)
  const next = repairedPersistedEnvironment(existing, offer, now, 'ssh-tunnel')
  assertPairingUsesLoopbackPort(next, deployment.localPort, MANAGED_PORT_MISMATCH)
  const environments = withEnvironmentReplaced(store.environments, next)
  const { binding: _binding, ...rest } = entry ?? {}
  const state = { ...rest, orcadDeployment: deployment }
  // Why three writes: the entry stays current for both store states, so a failed or interrupted
  // store write can never strand the deployment link.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, existing, state, next)
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, next, state)
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}

/**
 * Marks a managed server as holding migrated state from `at` on. Written before a commit is
 * attempted, so a crash after the commit can never leave a rollback across it unblocked.
 */
export function recordManagedOrcadMigration(
  userDataPath: string,
  environmentId: string,
  at: string
): KnownRuntimeEnvironment {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  if (!entry?.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const { binding: _binding, ...state } = entry
  // The latest mark wins and never moves back: a snapshot older than any migration, including a
  // later delta move, must stay out of reach.
  const latest =
    state.orcadMigratedAt && Date.parse(state.orcadMigratedAt) >= Date.parse(at)
      ? state.orcadMigratedAt
      : at
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, persisted, {
    ...state,
    orcadMigratedAt: latest
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}
