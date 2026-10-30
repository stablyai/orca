import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { isProfileRuntimePublicKey } from './runtime-e2ee-keypair-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment,
  type RuntimeEnvironmentSource
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { writeRuntimeEnvironmentSidecarEntry } from './runtime-environment-sidecar'
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'
import {
  findEnvironmentWithHostKey,
  savedHostKeySpelling
} from './runtime-environment-host-key-match'
import {
  assertNoIndependentSshAccess,
  assertPairingReplaceableByAdd
} from './runtime-environment-pairing-replace-guards'
import { remoteServerPairingStoreError } from './runtime-environment-store-records'

export {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from './runtime-environment-store-file'

export function listEnvironments(
  userDataPath: string,
  options: Parameters<typeof readEnvironmentStore>[1] = {}
): KnownRuntimeEnvironment[] {
  return readEnvironmentStore(userDataPath, options).environments
}

export type AddEnvironmentArgs = {
  name: string
  pairingCode: string
  now?: number
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
  /** Recorded only when the code turns out to be for an already saved server. */
  runtimeId?: string
}

export type AddEnvironmentOutcome = {
  environment: KnownRuntimeEnvironment
  /** The code was for a saved server, whose pairing it replaced instead of adding a second entry. */
  updatedExisting: boolean
}

/** Reject duplicate host keys: two saved entries publish identical workspaces and make writes ambiguous. */
export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs
): KnownRuntimeEnvironment {
  return saveEnvironmentFromPairingCode(userDataPath, args, false).environment
}

/** Refresh in place only when the caller also retires app connections authenticated with the replaced pairing. */
export function addOrUpdateEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs
): AddEnvironmentOutcome {
  return saveEnvironmentFromPairingCode(userDataPath, args, true)
}

function saveEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs,
  refreshSameServer: boolean
): AddEnvironmentOutcome {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  const now = args.now ?? Date.now()
  const store = readPersistedEnvironmentStore(userDataPath, { recoverBlankStore: true })
  const samePersisted = findEnvironmentWithHostKey(store.environments, offer.publicKeyB64)
  // Why the overlaid entry: SSH access or a deployment lives only there, and the guard reads it.
  const samePaired =
    samePersisted &&
    readEnvironmentStore(userDataPath).environments.find((entry) => entry.id === samePersisted.id)
  if (samePersisted && !samePaired) {
    throw remoteServerPairingStoreError('alreadyPairedUnreadable', { name: samePersisted.name })
  }
  if (samePaired) {
    assertPairingReplaceableByAdd(samePaired, args.source, refreshSameServer)
    const sameSpelling = { ...offer, publicKeyB64: savedHostKeySpelling(samePaired, offer) }
    const environment = replaceEnvironmentPairing(userDataPath, samePaired.id, sameSpelling, {
      now,
      runtimeId: args.runtimeId,
      connectionDependency: args.connectionDependency
    })
    return { environment, updatedExisting: true }
  }
  const existing = findCollidingEnvironmentName(store.environments, args.name)
  if (existing) {
    throw remoteServerPairingStoreError('nameTaken', { name: existing.name })
  }
  const environment = createEnvironmentFromPairingOffer({
    id: randomUUID(),
    name: args.name,
    now,
    offer,
    runtimeId: null,
    ...(args.source ? { source: args.source } : {}),
    ...getPairingConnectionDependency(args.connectionDependency, offer)
  })
  const next = {
    version: 1 as const,
    environments: [
      ...store.environments.filter((entry) => entry.id !== environment.id),
      environment
    ].sort((a, b) => a.name.localeCompare(b.name))
  }
  writeEnvironmentStore(userDataPath, next)
  return { environment, updatedExisting: false }
}

function parseRemotePairingCode(userDataPath: string, pairingCode: string): PairingOffer {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw remoteServerPairingStoreError('invalidPairingCode')
  }
  // Why the key, not the address: a loopback or LAN address proves nothing either way.
  if (isProfileRuntimePublicKey(userDataPath, offer.publicKeyB64)) {
    throw remoteServerPairingStoreError('selfPairingCode')
  }
  return offer
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  const environment = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
  assertNoIndependentSshAccess(environment)
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environment.id)
  const remaining = store.environments.filter((entry) => entry.id !== environment.id)
  writeEnvironmentStore(userDataPath, { version: 1, environments: remaining })
  // A leftover entry would read as stale anyway; dropping it keeps the sidecar from growing.
  writeRuntimeEnvironmentSidecarEntry(userDataPath, remaining, persisted, null)
  return environment
}

export function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number; runtimeId?: string }
): KnownRuntimeEnvironment {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
  assertNoIndependentSshAccess(current)
  return replaceEnvironmentPairing(userDataPath, selector, offer, {
    now: args.now ?? Date.now(),
    runtimeId: args.runtimeId,
    connectionDependency: current.connectionDependency
  })
}

/** Swaps a saved server's pairing in place, keeping its id, name and history. */
function replaceEnvironmentPairing(
  userDataPath: string,
  selector: string,
  offer: PairingOffer,
  args: { now: number; runtimeId?: string; connectionDependency?: 'ssh-tunnel' }
): KnownRuntimeEnvironment {
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const environment = createEnvironmentFromPairingOffer({
    id: existing.id,
    name: existing.name,
    now: existing.createdAt,
    offer,
    runtimeId: args.runtimeId ?? existing.runtimeId,
    ...(existing.source ? { source: existing.source } : {}),
    ...getPairingConnectionDependency(args.connectionDependency, offer)
  })
  const next = {
    ...environment,
    createdAt: existing.createdAt,
    updatedAt: args.now,
    pairingRevision: Math.max(args.now, previousPairingRevision + 1),
    lastUsedAt: existing.lastUsedAt
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return next
}

function getPairingConnectionDependency(
  dependency: 'ssh-tunnel' | undefined,
  offer: PairingOffer
): { connectionDependency?: 'ssh-tunnel' } {
  if (!dependency) {
    return {}
  }
  try {
    const endpoint = new URL(offer.endpoint)
    return classifyRemotePairingHostname(endpoint.hostname) === 'loopback'
      ? { connectionDependency: dependency }
      : {}
  } catch {
    return {}
  }
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return getPreferredPairingOffer(resolveEnvironment(userDataPath, selector))
}

// Throttle lastUsedAt: per-RPC secure-file/Windows ACL rewrites block main; coarse freshness is enough.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: {
    runtimeId?: string | null
    /** Recorded only with `pairingDeviceToken`, and only while that token is still the saved one. */
    pairedDeviceId?: string
    /** The token the reply was authenticated with; identity from any other pairing is ignored. */
    pairingDeviceToken?: string
    now?: number
  } = {}
): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  // Ignore identity from replies racing a re-pair; attaching the old device to the new token breaks subsequent checks.
  const fromSavedPairing =
    args.pairingDeviceToken === undefined ||
    preferredDeviceToken(environment) === args.pairingDeviceToken
  const runtimeIdChanged =
    fromSavedPairing && args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const pairedDeviceIdChanged =
    fromSavedPairing &&
    args.pairingDeviceToken !== undefined &&
    args.pairedDeviceId != null &&
    args.pairedDeviceId !== environment.pairedDeviceId
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  if (!runtimeIdChanged && !pairedDeviceIdChanged && lastUsedIsFresh) {
    return
  }
  if (runtimeIdChanged || pairedDeviceIdChanged) {
    const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environment.id)
    // orcad mints a runtimeId per start; only a pending link must keep the runtime it verifies.
    const intent = current.pendingSshAccessOperation
    if (intent?.operation === 'link' || (pairedDeviceIdChanged && (current.sshAccess || intent))) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        'SSH access operation cannot change the paired runtime identity.'
      )
    }
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: (runtimeIdChanged ? args.runtimeId : null) ?? entry.runtimeId,
          ...(pairedDeviceIdChanged && args.pairedDeviceId
            ? { pairedDeviceId: args.pairedDeviceId }
            : {}),
          lastUsedAt: now,
          updatedAt: now
        }
      : entry
  )
  writeEnvironmentStore(userDataPath, { version: 1, environments: next })
}

function preferredDeviceToken(environment: PersistedRuntimeEnvironment): string | undefined {
  return (
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  )?.deviceToken
}

export function resolveEnvironmentFromStore<T extends PersistedRuntimeEnvironment>(
  store: { environments: T[] },
  selector: string
): T {
  const byId = store.environments.find((entry) => entry.id === selector)
  if (byId) {
    return byId
  }
  const matches = store.environments.filter((entry) => entry.name === selector)
  if (matches.length === 1) {
    return matches[0]!
  }
  if (matches.length > 1) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `Environment name "${selector}" is ambiguous; use the environment id.`
    )
  }
  throw new RuntimeEnvironmentStoreError('invalid_argument', `Unknown environment: ${selector}`)
}
