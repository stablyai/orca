import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePairingCode, type PairingOffer } from './pairing'
import { hardenExistingSecureFile, writeSecureJsonFile } from './secure-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'

const ENVIRONMENTS_FILE = 'orca-environments.json'

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

export function listEnvironments(userDataPath: string): KnownRuntimeEnvironment[] {
  return readEnvironmentStore(userDataPath).environments
}

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: { name: string; pairingCode: string; now?: number; source?: RuntimeEnvironmentSource }
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
  const existing = store.environments.find((entry) => entry.name === args.name)
  if (existing) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${args.name}" already exists.`
    )
  }
  const environment = createEnvironmentFromPairingOffer({
    id: randomUUID(),
    name: args.name,
    now,
    offer,
    runtimeId: null,
    ...(args.source ? { source: args.source } : {})
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
  const now = args.now ?? Date.now()
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const environment = createEnvironmentFromPairingOffer({
    id: existing.id,
    name: existing.name,
    now: existing.createdAt,
    offer,
    runtimeId: existing.runtimeId,
    ...(existing.source ? { source: existing.source } : {})
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
  args: { runtimeId?: string | null; now?: number } = {}
): void {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const runtimeIdChanged = args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  if (!runtimeIdChanged && lastUsedIsFresh) {
    return
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: args.runtimeId ?? entry.runtimeId,
          lastUsedAt: now,
          updatedAt: now
        }
      : entry
  )
  writeEnvironmentStore(userDataPath, { version: 1, environments: next })
}

function resolveEnvironmentFromStore(
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

function readEnvironmentStore(userDataPath: string): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, environments: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = RuntimeEnvironmentStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return {
      version: 1,
      environments: parsed.environments
        .map((entry) => KnownRuntimeEnvironmentSchema.parse(entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
}

function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  writeSecureJsonFile(path, RuntimeEnvironmentStoreSchema.parse(store))
}
