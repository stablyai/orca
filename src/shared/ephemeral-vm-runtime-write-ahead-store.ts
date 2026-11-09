import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from './file-content/node-bounded-file-reader'
import { writeSecureJsonFileWithinLimit } from './secure-storage/bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-storage/secure-file'
import {
  EphemeralVmRuntimeRecordSchema,
  hasEphemeralVmRecipeResult,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

// Older builds never read this file, so result-less write-ahead records cannot break their store parse.
const EPHEMERAL_VM_WRITE_AHEAD_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes-write-ahead.json'
const MAX_WRITE_AHEAD_STORE_FILE_BYTES = 1024 * 1024

export function getEphemeralVmWriteAheadRuntimeStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_WRITE_AHEAD_RUNTIMES_FILE)
}

const WriteAheadRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(EphemeralVmRuntimeRecordSchema)
})

/** The main file wins: a crash between flipping to running and pruning the sidecar leaves both copies. */
export function withWriteAheadRuntimes(
  userDataPath: string,
  mainRuntimes: EphemeralVmRuntimeRecord[]
): EphemeralVmRuntimeRecord[] {
  const mainIds = new Set(mainRuntimes.map((entry) => entry.id))
  return [
    ...mainRuntimes,
    ...readWriteAheadRuntimes(userDataPath).filter((entry) => !mainIds.has(entry.id))
  ]
}

function readWriteAheadRuntimes(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return readWriteAheadFile(getEphemeralVmWriteAheadRuntimeStorePath(userDataPath)).runtimes
}

type WriteAheadFileState = 'missing' | 'readable' | 'unreadable'

function readWriteAheadFile(path: string): {
  runtimes: EphemeralVmRuntimeRecord[]
  state: WriteAheadFileState
} {
  let text: string
  try {
    text = readNodeFileSyncWithinLimit(path, MAX_WRITE_AHEAD_STORE_FILE_BYTES).buffer.toString(
      'utf8'
    )
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    return { runtimes: [], state: missing ? 'missing' : 'unreadable' }
  }
  try {
    hardenExistingSecureFile(path)
    const runtimes = WriteAheadRuntimeStoreSchema.parse(JSON.parse(text)).runtimes.filter(
      (entry) => !hasEphemeralVmRecipeResult(entry)
    )
    return { runtimes, state: 'readable' }
  } catch {
    // Why: an unreadable sidecar must not block cleanup of tracked VMs in the main file.
    return { runtimes: [], state: 'unreadable' }
  }
}

export function writeWriteAheadRuntimes(
  userDataPath: string,
  runtimes: readonly EphemeralVmRuntimeRecord[]
): void {
  const path = getEphemeralVmWriteAheadRuntimeStorePath(userDataPath)
  const existing = readWriteAheadFile(path)
  if (existing.state === 'unreadable') {
    // Why: never overwrite records this build cannot read (corrupt, or from a newer build); they
    // may be the only trace of a VM. Refuse new records instead, before their create starts.
    if (runtimes.length > 0) {
      throw new Error(`Could not update Orca ephemeral VM provisioning records at ${path}.`)
    }
    return
  }
  // Most store writes touch only tracked VMs; skip the durable write when there is nothing to change.
  if (runtimes.length === 0 && existing.runtimes.length === 0) {
    return
  }
  writeSecureJsonFileWithinLimit(path, { version: 1, runtimes }, MAX_WRITE_AHEAD_STORE_FILE_BYTES, {
    durable: true
  })
}
