import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type OrcadSshDeploymentLink
} from './runtime-environments'
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
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'

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
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  const known = readEnvironmentStore(userDataPath).environments
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
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now: args.now ?? Date.now(),
    offer,
    runtimeId: null,
    connectionDependency: 'ssh-tunnel'
  })
  if (getPreferredLoopbackRuntimePort(environment) !== args.orcadDeployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  const environments = [
    ...readPersistedEnvironmentStore(userDataPath).environments,
    persisted
  ].sort((a, b) => a.name.localeCompare(b.name))
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
      'This host’s Orca server was saved without its deployment link.'
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
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  return rebindManagedOrcadPairing(userDataPath, environmentId, () => offer, null, now)
}

/** Moves a managed server's tunnel to a new local port, keeping its pairing and identity. */
export function moveManagedOrcadLocalPort(
  userDataPath: string,
  environmentId: string,
  localPort: number,
  now = Date.now()
): KnownRuntimeEnvironment {
  return rebindManagedOrcadPairing(
    userDataPath,
    environmentId,
    (current) => {
      const offer = getPreferredPairingOffer(current)
      const endpoint = new URL(offer.endpoint)
      endpoint.port = String(localPort)
      return { ...offer, endpoint: endpoint.toString() }
    },
    localPort,
    now
  )
}

function rebindManagedOrcadPairing(
  userDataPath: string,
  environmentId: string,
  nextOffer: (current: KnownRuntimeEnvironment) => PairingOffer,
  localPort: number | null,
  now: number
): KnownRuntimeEnvironment {
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
  const offer = nextOffer(current)
  const nextDeployment = { ...deployment, localPort: localPort ?? deployment.localPort }
  // Why skip: orcad keeps its device registry across versions and callers pass the enrolled grant,
  // so an unchanged offer needs no rewrite, and every rewrite re-binds the sidecar entry.
  if (samePairing(getPreferredPairingOffer(current), offer)) {
    return current
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)
  const next = PersistedRuntimeEnvironmentSchema.parse({
    ...createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId,
      connectionDependency: 'ssh-tunnel'
    }),
    updatedAt: now,
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    lastUsedAt: existing.lastUsedAt
  })
  if (getPreferredLoopbackRuntimePort(next) !== nextDeployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const environments = store.environments.map((candidate) =>
    candidate.id === existing.id ? next : candidate
  )
  const { binding: _binding, ...rest } = entry ?? {}
  // Why three writes: the entry stays current for both store states, so a failed or interrupted
  // store write can never strand the deployment link. In between, a moved port is read from the
  // stored endpoint.
  writeRuntimeEnvironmentSidecarEntry(
    userDataPath,
    store.environments,
    existing,
    { ...rest, orcadDeployment: deployment },
    next
  )
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, next, {
    ...rest,
    orcadDeployment: nextDeployment
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}

function samePairing(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
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
