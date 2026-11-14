import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './json-stream/node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './file-content/node-bounded-file-reader'
import { writeSecureJsonFileWithinLimit } from './secure-storage/bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-storage/secure-file'
import { toCleanupLastErrorFields, toLifecycleLastErrorFields } from './ephemeral-vm-failure-copy'
import { notifyEphemeralVmRuntimesChanged } from './ephemeral-vm-runtime-store-events'
import {
  featureEntryFromRuntime,
  featureIdentity,
  readEphemeralVmRuntimeFeatureStore,
  restoreRuntimeFeatureList,
  runtimeFeaturesEqual,
  writeEphemeralVmRuntimeFeatureStore,
  type EphemeralVmRuntimeFeatureStoreSnapshot
} from './ephemeral-vm-runtime-feature-store'
import {
  mergeRuntimeFeatures,
  partitionRuntimesForRollback,
  runtimeFeatureListsEqual
} from './ephemeral-vm-runtime-rollback-projection'
import {
  hasEphemeralVmRecipeResult,
  EphemeralVmRuntimeRecordSchema,
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStatusPatch,
  type EphemeralVmRuntimeStore
} from './ephemeral-vm-runtimes'
import {
  withWriteAheadRuntimes,
  writeWriteAheadRuntimes
} from './ephemeral-vm-runtime-write-ahead-store'

export { getEphemeralVmWriteAheadRuntimeStorePath } from './ephemeral-vm-runtime-write-ahead-store'

const EPHEMERAL_VM_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes.json'
export const MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES = 1024 * 1024

export type EphemeralVmRuntimeStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class EphemeralVmRuntimeStoreError extends Error {
  readonly code: EphemeralVmRuntimeStoreErrorCode

  constructor(code: EphemeralVmRuntimeStoreErrorCode, message: string) {
    super(message)
    this.name = 'EphemeralVmRuntimeStoreError'
    this.code = code
  }
}

export function getEphemeralVmRuntimeStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_RUNTIMES_FILE)
}

export function listEphemeralVmRuntimes(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath).store.runtimes
}

export function upsertEphemeralVmRuntime(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const previous = loaded.store.runtimes.find((entry) => entry.id === parsed.id)
  if (
    previous &&
    hasEphemeralVmRecipeResult(previous) &&
    featureIdentity(previous) === featureIdentity(parsed) &&
    !runtimeFeaturesEqual(previous, parsed)
  ) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Cannot change compatibility features for ephemeral VM runtime: ${parsed.id}`
    )
  }
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: [...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id), parsed].sort(
        compareRuntimeRecords
      )
    },
    loaded.features
  )
  return parsed
}

export function upsertEphemeralVmRuntimeRollbackRecovery(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): void {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    writeSecureJsonFileWithinLimit(
      path,
      RollbackEphemeralVmRuntimeStoreSchema.parse({
        version: 1,
        runtimes: partitionRuntimesForRollback(
          [...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id), parsed].sort(
            compareRuntimeRecords
          )
        ).rollback
      }),
      MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
      { durable: true }
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        `Could not write Orca ephemeral VM runtimes at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}

export function updateEphemeralVmRuntimeStatus(
  userDataPath: string,
  id: string,
  args: EphemeralVmRuntimeStatusPatch
): EphemeralVmRuntimeRecord {
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const existing = loaded.store.runtimes.find((entry) => entry.id === id)
  if (!existing) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Unknown ephemeral VM runtime: ${id}`
    )
  }
  const next = EphemeralVmRuntimeRecordSchema.parse({
    ...existing,
    ...(args.status ? { status: args.status } : {}),
    ...(args.cleanupStatus ? { cleanupStatus: args.cleanupStatus } : {}),
    ...(args.cleanupLastAttemptAt !== undefined
      ? { cleanupLastAttemptAt: args.cleanupLastAttemptAt }
      : {}),
    ...(args.cleanupLastError === null || args.cleanupLastError
      ? toCleanupLastErrorFields(
          typeof args.cleanupLastError === 'string'
            ? { error: args.cleanupLastError }
            : args.cleanupLastError
        )
      : {}),
    ...toLifecycleLastErrorFields(args.lifecycleLastError),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    // null explicitly clears the field (e.g. terminal cleanup); undefined leaves it unchanged.
    ...(args.connectionMode === null
      ? { connectionMode: undefined }
      : args.connectionMode
        ? { connectionMode: args.connectionMode }
        : {}),
    ...(args.runtimeEnvironmentId ? { runtimeEnvironmentId: args.runtimeEnvironmentId } : {}),
    ...(args.sshTargetId === null
      ? { sshTargetId: undefined }
      : args.sshTargetId
        ? { sshTargetId: args.sshTargetId }
        : {}),
    ...(args.recipeResult ? { recipeResult: args.recipeResult } : {}),
    updatedAt: args.updatedAt ?? Date.now()
  })
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: loaded.store.runtimes
        .map((entry) => (entry.id === id ? next : entry))
        .sort(compareRuntimeRecords)
    },
    loaded.features
  )
  return next
}

export function removeEphemeralVmRuntime(
  userDataPath: string,
  id: string
): EphemeralVmRuntimeRecord {
  const loaded = readEphemeralVmRuntimeStore(userDataPath)
  const existing = loaded.store.runtimes.find((entry) => entry.id === id)
  if (!existing) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Unknown ephemeral VM runtime: ${id}`
    )
  }
  writeEphemeralVmRuntimeStore(
    userDataPath,
    {
      version: 1,
      runtimes: loaded.store.runtimes.filter((entry) => entry.id !== id)
    },
    loaded.features
  )
  return existing
}

type LoadedEphemeralVmRuntimeStore = {
  store: EphemeralVmRuntimeStore
  features: EphemeralVmRuntimeFeatureStoreSnapshot
}

function readEphemeralVmRuntimeStore(userDataPath: string): LoadedEphemeralVmRuntimeStore {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  if (!existsSync(path)) {
    return {
      store: {
        version: 1,
        runtimes: withWriteAheadRuntimes(userDataPath, []).sort(compareRuntimeRecords)
      },
      features: readEphemeralVmRuntimeFeatureStore(userDataPath)
    }
  }
  try {
    hardenExistingSecureFile(path)
    const persisted = JSON.parse(
      readNodeFileSyncWithinLimit(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES).buffer.toString(
        'utf8'
      )
    )
    const parsed = EphemeralVmRuntimeStoreSchema.parse(persisted)
    const features = readEphemeralVmRuntimeFeatureStore(userDataPath)
    const store: EphemeralVmRuntimeStore = {
      version: 1,
      runtimes: withWriteAheadRuntimes(
        userDataPath,
        restoreRuntimeFeatureList(parsed.runtimes, features.features)
      ).sort(compareRuntimeRecords)
    }
    if (features.writable && !RollbackEphemeralVmRuntimeStoreSchema.safeParse(persisted).success) {
      try {
        writeEphemeralVmRuntimeStore(userDataPath, store, features)
      } catch {
        // Why: a failed migration must not block cleanup through the still-readable current shape.
      }
    }
    return { store, features }
  } catch {
    throw new EphemeralVmRuntimeStoreError(
      'runtime_error',
      `Could not read Orca ephemeral VM runtimes at ${path}; the file is invalid.`
    )
  }
}

function writeEphemeralVmRuntimeStore(
  userDataPath: string,
  store: EphemeralVmRuntimeStore,
  features: EphemeralVmRuntimeFeatureStoreSnapshot
): void {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    const parsed = EphemeralVmRuntimeStoreSchema.parse(store)
    const { rollback, writeAhead } = partitionRuntimesForRollback(parsed.runtimes)
    const requiredFeatures = mergeRuntimeFeatures(
      [],
      parsed.runtimes.filter(hasEphemeralVmRecipeResult).flatMap((entry) => {
        const feature = featureEntryFromRuntime(entry)
        return feature ? [feature] : []
      })
    )
    const preparedFeatures = mergeRuntimeFeatures(features.features, requiredFeatures)
    writeSecureJsonFileWithinLimit(
      path,
      RollbackEphemeralVmRuntimeStoreSchema.parse({ version: 1, runtimes: rollback }),
      MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
      { durable: preparedFeatures.length > 0 || features.features.length > 0 }
    )
    // Main first so a record gaining its recipe result is never absent from both files.
    writeWriteAheadRuntimes(userDataPath, writeAhead)
    notifyEphemeralVmRuntimesChanged()
    if (!features.writable && requiredFeatures.length > 0) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        'Could not preserve ephemeral VM runtime compatibility metadata.'
      )
    }
    if (features.writable && !runtimeFeatureListsEqual(features.features, preparedFeatures)) {
      writeEphemeralVmRuntimeFeatureStore(userDataPath, features, preparedFeatures)
    }
    if (features.writable && !runtimeFeatureListsEqual(preparedFeatures, requiredFeatures)) {
      try {
        writeEphemeralVmRuntimeFeatureStore(userDataPath, features, requiredFeatures)
      } catch {
        // Stale feature records do not match any persisted runtime identity.
      }
    }
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        `Could not write Orca ephemeral VM runtimes at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}

function compareRuntimeRecords(a: EphemeralVmRuntimeRecord, b: EphemeralVmRuntimeRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
