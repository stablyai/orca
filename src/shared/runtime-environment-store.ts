import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import {
  readEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getPreferredPairingOffer,
  KnownRuntimeEnvironmentSchema,
  OrcadDeploymentLinkSchema,
  type KnownRuntimeEnvironment,
  type OrcadDeploymentLink,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'

export {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from './runtime-environment-store-file'

export function listEnvironments(userDataPath: string): KnownRuntimeEnvironment[] {
  return readEnvironmentStore(userDataPath).environments
}

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: {
    id?: string
    name: string
    pairingCode: string
    now?: number
    source?: RuntimeEnvironmentSource
    connectionDependency?: 'ssh-tunnel'
    orcadDeployment?: OrcadDeploymentLink
  }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  const store = readEnvironmentStore(userDataPath)
  const now = args.now ?? Date.now()
  if (args.id && store.environments.some((entry) => entry.id === args.id)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server with id "${args.id}" already exists.`
    )
  }
  const existing = store.environments.find((entry) => entry.name === args.name)
  if (existing) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${args.name}" already exists.`
    )
  }
  const environment = createEnvironmentFromPairingOffer({
    id: args.id ?? randomUUID(),
    name: args.name,
    now,
    offer,
    runtimeId: null,
    ...(args.source ? { source: args.source } : {}),
    ...getPairingSshMetadata(args.connectionDependency, args.orcadDeployment, offer)
  })
  const next = {
    version: 1 as const,
    environments: [
      ...store.environments.filter((entry) => entry.id !== environment.id),
      environment
    ].sort((a, b) => a.name.localeCompare(b.name))
  }
  writeEnvironmentStore(userDataPath, next)
  return environment
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  assertNoIndependentSshAccess(environment)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.filter((entry) => entry.id !== environment.id)
  })
  return environment
}

export function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  const store = readEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  assertNoIndependentSshAccess(existing)
  const now = args.now ?? Date.now()
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const environment = createEnvironmentFromPairingOffer({
    id: existing.id,
    name: existing.name,
    now: existing.createdAt,
    offer,
    runtimeId: existing.runtimeId,
    ...(existing.source ? { source: existing.source } : {}),
    ...getPairingSshMetadata(existing.connectionDependency, existing.orcadDeployment, offer)
  })
  const next = {
    ...environment,
    createdAt: existing.createdAt,
    updatedAt: now,
    pairingRevision: Math.max(now, previousPairingRevision + 1),
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

export function restoreManagedOrcadEnvironmentLink(
  userDataPath: string,
  selector: string,
  deployment: Omit<OrcadDeploymentLink, 'localPort'>
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  assertNoIndependentSshAccess(existing)
  const localPort = getPreferredLoopbackRuntimePort(existing)
  if (localPort === null) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The saved managed Orca environment does not have an explicit loopback endpoint.'
    )
  }
  const orcadDeployment = OrcadDeploymentLinkSchema.parse({ ...deployment, localPort })
  if (
    existing.orcadDeployment &&
    !managedOrcadDeploymentLinksEqual(existing.orcadDeployment, orcadDeployment)
  ) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The saved managed Orca environment has conflicting deployment metadata.'
    )
  }
  const next = KnownRuntimeEnvironmentSchema.parse({
    ...existing,
    connectionDependency: 'ssh-tunnel',
    orcadDeployment
  })
  if (
    existing.connectionDependency === 'ssh-tunnel' &&
    existing.orcadDeployment &&
    managedOrcadDeploymentLinksEqual(existing.orcadDeployment, orcadDeployment)
  ) {
    return existing
  }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.map((entry) => (entry.id === existing.id ? next : entry))
  })
  return next
}

function managedOrcadDeploymentLinksEqual(
  left: OrcadDeploymentLink,
  right: OrcadDeploymentLink
): boolean {
  return (
    left.sshTargetId === right.sshTargetId &&
    left.sshTargetGeneration === right.sshTargetGeneration &&
    left.localPort === right.localPort &&
    left.remotePort === right.remotePort
  )
}

function assertNoIndependentSshAccess(environment: KnownRuntimeEnvironment): void {
  if (environment.sshAccess || environment.pendingSshAccessOperation) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "Unlink this server's SSH access before replacing its pairing, removing it, or managing its deployment."
    )
  }
}

function getPairingSshMetadata(
  dependency: 'ssh-tunnel' | undefined,
  deployment: OrcadDeploymentLink | undefined,
  offer: PairingOffer
): { connectionDependency?: 'ssh-tunnel'; orcadDeployment?: OrcadDeploymentLink } {
  if (!dependency && !deployment) {
    return {}
  }
  try {
    const endpoint = new URL(offer.endpoint)
    if (classifyRemotePairingHostname(endpoint.hostname) !== 'loopback') {
      return {}
    }
    return {
      ...(dependency ? { connectionDependency: dependency } : {}),
      ...(deployment ? { orcadDeployment: deployment } : {})
    }
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

// Why: markEnvironmentUsed runs on every runtime round-trip; persisting lastUsedAt each
// time forces a secure-file rewrite (ACL hardening), which blocks the main thread on
// Windows. lastUsedAt only needs coarse freshness, so skip writes within this window.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): void {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const runtimeIdChanged = args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const pairedDeviceIdChanged =
    args.pairedDeviceId != null && args.pairedDeviceId !== environment.pairedDeviceId
  if (
    (runtimeIdChanged || pairedDeviceIdChanged) &&
    (environment.sshAccess || environment.pendingSshAccessOperation)
  ) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'SSH access operation cannot change the paired runtime identity.'
    )
  }
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  if (!runtimeIdChanged && !pairedDeviceIdChanged && lastUsedIsFresh) {
    return
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: args.runtimeId ?? entry.runtimeId,
          ...(args.pairedDeviceId ? { pairedDeviceId: args.pairedDeviceId } : {}),
          lastUsedAt: now,
          updatedAt: now
        }
      : entry
  )
  writeEnvironmentStore(userDataPath, { version: 1, environments: next })
}

export function resolveEnvironmentFromStore(
  store: RuntimeEnvironmentStore,
  selector: string
): KnownRuntimeEnvironment {
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
