import { existsSync } from 'node:fs'
import {
  readNodeFileSyncWithinLimit,
  type BoundedNodeFileRead
} from '../../file-content/node-bounded-file-reader'
import { hardenExistingSecureFile } from '../../secure-storage/secure-file'

let observation: Map<string, BoundedNodeFileRead | null> | undefined

/** Only commands admitted before this observation may share its bytes. */
export function withEnvironmentStoreObservation<T>(read: () => T): T {
  const previous = observation
  observation = new Map()
  try {
    return read()
  } finally {
    observation = previous
  }
}

export function invalidateEnvironmentStoreObservation(path?: string): void {
  if (path === undefined) {
    observation?.clear()
  } else {
    observation?.delete(path)
  }
}

export function readEnvironmentRegistryFile(
  path: string,
  maxBytes: number
): BoundedNodeFileRead | null {
  if (observation?.has(path)) {
    return observation.get(path) ?? null
  }
  let read: BoundedNodeFileRead | null = null
  if (existsSync(path)) {
    hardenExistingSecureFile(path)
    read = readNodeFileSyncWithinLimit(path, maxBytes)
  }
  observation?.set(path, read)
  return read
}
