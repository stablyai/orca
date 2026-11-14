import {
  readNodeFileSyncWithinLimit,
  type BoundedNodeFileRead
} from '../../file-content/node-bounded-file-reader'
import { hardenExistingSecureFile } from '../../secure-storage/secure-file'
import { isWslHostsServing } from '../../wsl-host-internal-gate'

let observation: Map<string, BoundedNodeFileRead | null> | undefined
let servingWsl: boolean | undefined

export function environmentStoreServesWsl(): boolean {
  return servingWsl ?? isWslHostsServing(process.env)
}

/** Only commands admitted before this observation may share its bytes. */
export function withEnvironmentStoreObservation<T>(read: () => T, servesWsl?: boolean): T {
  const previous = observation
  const previousPolicy = servingWsl
  observation = new Map()
  servingWsl = servesWsl
  try {
    return read()
  } finally {
    observation = previous
    servingWsl = previousPolicy
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
  try {
    hardenExistingSecureFile(path)
    read = readNodeFileSyncWithinLimit(path, maxBytes)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  observation?.set(path, read)
  return read
}
