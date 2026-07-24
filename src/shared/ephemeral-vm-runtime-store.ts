import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from './secure-file'
import {
  EphemeralVmRuntimeRecordSchema,
  EphemeralVmRuntimeStoreSchema,
  type EphemeralVmCleanupStatus,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStatus,
  type EphemeralVmRuntimeStore
} from './ephemeral-vm-runtimes'

const EPHEMERAL_VM_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes.json'

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
  return readEphemeralVmRuntimeStore(userDataPath).runtimes
}

export function upsertEphemeralVmRuntime(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  const store = readEphemeralVmRuntimeStore(userDataPath)
  writeEphemeralVmRuntimeStore(userDataPath, {
    version: 1,
    runtimes: [...store.runtimes.filter((entry) => entry.id !== parsed.id), parsed].sort(
      compareRuntimeRecords
    )
  })
  return parsed
}

export function updateEphemeralVmRuntimeStatus(
  userDataPath: string,
  id: string,
  args: {
    status?: EphemeralVmRuntimeStatus
    cleanupStatus?: EphemeralVmCleanupStatus
    cleanupLastAttemptAt?: number
    cleanupLastError?: string | null
    workspaceId?: string
    workspaceName?: string
    connectionMode?: EphemeralVmRuntimeRecord['connectionMode'] | null
    runtimeEnvironmentId?: string
    sshTargetId?: string | null
    recipeResult?: EphemeralVmRuntimeRecord['recipeResult']
    updatedAt?: number
  }
): EphemeralVmRuntimeRecord {
  const store = readEphemeralVmRuntimeStore(userDataPath)
  const existing = store.runtimes.find((entry) => entry.id === id)
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
    ...(args.cleanupLastError === null
      ? { cleanupLastError: undefined }
      : args.cleanupLastError
        ? { cleanupLastError: args.cleanupLastError }
        : {}),
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
  writeEphemeralVmRuntimeStore(userDataPath, {
    version: 1,
    runtimes: store.runtimes
      .map((entry) => (entry.id === id ? next : entry))
      .sort(compareRuntimeRecords)
  })
  return next
}

export function removeEphemeralVmRuntime(
  userDataPath: string,
  id: string
): EphemeralVmRuntimeRecord {
  const store = readEphemeralVmRuntimeStore(userDataPath)
  const existing = store.runtimes.find((entry) => entry.id === id)
  if (!existing) {
    throw new EphemeralVmRuntimeStoreError(
      'invalid_argument',
      `Unknown ephemeral VM runtime: ${id}`
    )
  }
  writeEphemeralVmRuntimeStore(userDataPath, {
    version: 1,
    runtimes: store.runtimes.filter((entry) => entry.id !== id)
  })
  return existing
}

function readEphemeralVmRuntimeStore(userDataPath: string): EphemeralVmRuntimeStore {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, runtimes: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = EphemeralVmRuntimeStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return {
      version: 1,
      runtimes: parsed.runtimes
        .map((entry) => EphemeralVmRuntimeRecordSchema.parse(entry))
        .sort(compareRuntimeRecords)
    }
  } catch {
    throw new EphemeralVmRuntimeStoreError(
      'runtime_error',
      `Could not read Orca ephemeral VM runtimes at ${path}; the file is invalid.`
    )
  }
}

function writeEphemeralVmRuntimeStore(userDataPath: string, store: EphemeralVmRuntimeStore): void {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  writeSecureJsonFile(path, EphemeralVmRuntimeStoreSchema.parse(store))
}

function compareRuntimeRecords(a: EphemeralVmRuntimeRecord, b: EphemeralVmRuntimeRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
