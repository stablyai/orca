import { existsSync, rmSync } from 'node:fs'
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

function readWriteAheadFile(path: string): {
  runtimes: EphemeralVmRuntimeRecord[]
  readable: boolean
} {
  if (!existsSync(path)) {
    return { runtimes: [], readable: true }
  }
  try {
    hardenExistingSecureFile(path)
    const runtimes = WriteAheadRuntimeStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_WRITE_AHEAD_STORE_FILE_BYTES).buffer.toString('utf8')
      )
    ).runtimes.filter((entry) => !hasEphemeralVmRecipeResult(entry))
    return { runtimes, readable: true }
  } catch {
    // Why: an unreadable sidecar must not block cleanup of tracked VMs in the main file.
    return { runtimes: [], readable: false }
  }
}

export function writeWriteAheadRuntimes(
  userDataPath: string,
  runtimes: readonly EphemeralVmRuntimeRecord[]
): void {
  const path = getEphemeralVmWriteAheadRuntimeStorePath(userDataPath)
  if (!existsSync(path)) {
    if (runtimes.length > 0) {
      writeWriteAheadFile(path, runtimes)
    }
    return
  }
  if (!readWriteAheadFile(path).readable) {
    // Why: never overwrite records this build cannot read (corrupt, or from a newer build); they
    // may be the only trace of a VM. Refuse new records instead, before their create starts.
    if (runtimes.length > 0) {
      throw new Error(`Could not update Orca ephemeral VM provisioning records at ${path}.`)
    }
    return
  }
  if (runtimes.length === 0) {
    rmSync(path, { force: true })
    return
  }
  writeWriteAheadFile(path, runtimes)
}

function writeWriteAheadFile(path: string, runtimes: readonly EphemeralVmRuntimeRecord[]): void {
  writeSecureJsonFileWithinLimit(path, { version: 1, runtimes }, MAX_WRITE_AHEAD_STORE_FILE_BYTES, {
    durable: true
  })
}
