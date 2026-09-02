import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-file'
import {
  EphemeralVmRuntimeRecordSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

const EPHEMERAL_VM_RUNTIME_FEATURES_FILE = 'orca-ephemeral-vm-runtime-features.json'
export const MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES = 1024 * 1024

const EphemeralVmRuntimeFeatureEntrySchema = z
  .object({
    id: z.string().min(1),
    recipeId: z.string().min(1),
    createdAt: z.number().finite(),
    recipeCheckoutMode: z.enum(['orca-worktree', 'provisioned-root']).optional(),
    resultCheckoutMode: z.literal('provisioned-root').optional()
  })
  .strict()

export type EphemeralVmRuntimeFeatureEntry = z.infer<typeof EphemeralVmRuntimeFeatureEntrySchema>

const EphemeralVmRuntimeFeatureStoreSchema = z
  .object({
    version: z.literal(1),
    records: z.array(z.unknown())
  })
  .strict()

export type EphemeralVmRuntimeFeatureStoreSnapshot =
  | {
      writable: true
      features: EphemeralVmRuntimeFeatureEntry[]
      retainedRecords: unknown[]
    }
  | {
      writable: false
      features: []
      retainedRecords: []
    }

export function getEphemeralVmRuntimeFeatureStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_RUNTIME_FEATURES_FILE)
}

export function assertEphemeralVmRuntimeCheckoutModeCanPersist(
  userDataPath: string,
  args: {
    id: string
    recipeId: string
    createdAt: number
    checkoutMode: NonNullable<NonNullable<EphemeralVmRuntimeRecord['recipe']>['checkoutMode']>
  }
): void {
  const snapshot = readEphemeralVmRuntimeFeatureStore(userDataPath)
  if (!snapshot.writable) {
    throw new Error('Could not preserve ephemeral VM runtime compatibility metadata.')
  }
  const required: EphemeralVmRuntimeFeatureEntry = {
    id: args.id,
    recipeId: args.recipeId,
    createdAt: args.createdAt,
    recipeCheckoutMode: args.checkoutMode,
    ...(args.checkoutMode === 'provisioned-root' ? { resultCheckoutMode: 'provisioned-root' } : {})
  }
  try {
    assertFeatureStoreCanPersist(snapshot, mergeFeatureEntries(snapshot.features, [required]))
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new Error(
        'Could not preserve ephemeral VM runtime compatibility metadata; the feature store exceeds its durable capacity.'
      )
    }
    throw error
  }
}

export function readEphemeralVmRuntimeFeatureStore(
  userDataPath: string
): EphemeralVmRuntimeFeatureStoreSnapshot {
  const path = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
  if (!existsSync(path)) {
    return { writable: true, features: [], retainedRecords: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = EphemeralVmRuntimeFeatureStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(
          path,
          MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
        ).buffer.toString('utf8')
      )
    )
    return parseFeatureRecords(parsed.records)
  } catch {
    return { writable: false, features: [], retainedRecords: [] }
  }
}

export function writeEphemeralVmRuntimeFeatureStore(
  userDataPath: string,
  snapshot: EphemeralVmRuntimeFeatureStoreSnapshot,
  features: EphemeralVmRuntimeFeatureEntry[]
): void {
  if (!snapshot.writable) {
    throw new Error('The ephemeral VM runtime feature store is not writable.')
  }
  writeSecureJsonFileWithinLimit(
    getEphemeralVmRuntimeFeatureStorePath(userDataPath),
    runtimeFeatureStoreValue(snapshot, features),
    MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES,
    { durable: true }
  )
}

function assertFeatureStoreCanPersist(
  snapshot: EphemeralVmRuntimeFeatureStoreSnapshot,
  features: EphemeralVmRuntimeFeatureEntry[]
): void {
  if (!snapshot.writable) {
    throw new Error('The ephemeral VM runtime feature store is not writable.')
  }
  stringifyJsonWithinByteLimit(
    runtimeFeatureStoreValue(snapshot, features),
    MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
  )
}

function mergeFeatureEntries(
  existing: readonly EphemeralVmRuntimeFeatureEntry[],
  required: readonly EphemeralVmRuntimeFeatureEntry[]
): EphemeralVmRuntimeFeatureEntry[] {
  const merged = new Map(existing.map((entry) => [featureIdentity(entry), entry]))
  for (const entry of required) {
    merged.set(featureIdentity(entry), entry)
  }
  return sortFeatures([...merged.values()])
}

export function featureEntryFromRuntime(
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeFeatureEntry | null {
  const recipeCheckoutMode = runtime.recipe?.checkoutMode
  const resultCheckoutMode =
    runtime.recipeResult.schemaVersion === 2 ? runtime.recipeResult.checkoutMode : undefined
  if (!recipeCheckoutMode && !resultCheckoutMode) {
    return null
  }
  return {
    id: runtime.id,
    recipeId: runtime.recipeId,
    createdAt: runtime.createdAt,
    ...(recipeCheckoutMode ? { recipeCheckoutMode } : {}),
    ...(resultCheckoutMode ? { resultCheckoutMode } : {})
  }
}

export function restoreRuntimeFeatures(
  runtime: EphemeralVmRuntimeRecord,
  features: readonly EphemeralVmRuntimeFeatureEntry[]
): EphemeralVmRuntimeRecord {
  const feature = features.find((entry) => featureIdentity(entry) === featureIdentity(runtime))
  if (!feature) {
    return runtime
  }
  return EphemeralVmRuntimeRecordSchema.parse({
    ...runtime,
    ...(runtime.recipe && feature.recipeCheckoutMode
      ? { recipe: { ...runtime.recipe, checkoutMode: feature.recipeCheckoutMode } }
      : {}),
    ...(feature.resultCheckoutMode
      ? {
          recipeResult: {
            ...runtime.recipeResult,
            schemaVersion: 2,
            checkoutMode: feature.resultCheckoutMode
          }
        }
      : {})
  })
}

export function runtimeFeaturesEqual(
  left: EphemeralVmRuntimeRecord,
  right: EphemeralVmRuntimeRecord
): boolean {
  return (
    JSON.stringify(featureEntryFromRuntime(left)) === JSON.stringify(featureEntryFromRuntime(right))
  )
}

export function featureIdentity(
  value: Pick<EphemeralVmRuntimeRecord, 'id' | 'recipeId' | 'createdAt'>
): string {
  return `${value.id}\0${value.recipeId}\0${value.createdAt}`
}

function parseFeatureRecords(records: unknown[]): EphemeralVmRuntimeFeatureStoreSnapshot {
  const features: EphemeralVmRuntimeFeatureEntry[] = []
  const retainedRecords: unknown[] = []
  const identities = new Map<string, string>()
  for (const record of records) {
    const parsed = EphemeralVmRuntimeFeatureEntrySchema.safeParse(record)
    if (!parsed.success) {
      retainedRecords.push(record)
      continue
    }
    const identity = featureIdentity(parsed.data)
    const serialized = JSON.stringify(parsed.data)
    const existing = identities.get(identity)
    if (existing && existing !== serialized) {
      return { writable: false, features: [], retainedRecords: [] }
    }
    if (!existing) {
      identities.set(identity, serialized)
      features.push(parsed.data)
    }
  }
  return { writable: true, features: sortFeatures(features), retainedRecords }
}

function sortFeatures(
  features: readonly EphemeralVmRuntimeFeatureEntry[]
): EphemeralVmRuntimeFeatureEntry[] {
  return [...features].sort((left, right) =>
    featureIdentity(left).localeCompare(featureIdentity(right))
  )
}

function runtimeFeatureStoreValue(
  snapshot: Extract<EphemeralVmRuntimeFeatureStoreSnapshot, { writable: true }>,
  features: EphemeralVmRuntimeFeatureEntry[]
): { version: 1; records: unknown[] } {
  return {
    version: 1,
    records: [...sortFeatures(features), ...snapshot.retainedRecords]
  }
}
