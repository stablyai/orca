import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

export const E2EE_KEYPAIR_FILENAME = 'orca-e2ee-keypair.json'
export const MAX_E2EE_KEYPAIR_FILE_BYTES = 8 * 1024

/** This profile's runtime public key, or null when the profile has none or it cannot be read. */
export function readProfileRuntimePublicKey(userDataPath: string): Buffer | null {
  const filePath = join(userDataPath, E2EE_KEYPAIR_FILENAME)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw: unknown = JSON.parse(
      readNodeFileSyncWithinLimit(filePath, MAX_E2EE_KEYPAIR_FILE_BYTES).buffer.toString('utf8')
    )
    if (typeof raw !== 'object' || raw === null || !('publicKeyB64' in raw)) {
      return null
    }
    const key =
      typeof raw.publicKeyB64 === 'string' ? Buffer.from(raw.publicKeyB64, 'base64') : null
    return key && key.length === 32 ? key : null
  } catch {
    return null
  }
}

export function isProfileRuntimePublicKey(userDataPath: string, publicKeyB64: string): boolean {
  const own = readProfileRuntimePublicKey(userDataPath)
  return own !== null && own.equals(Buffer.from(publicKeyB64, 'base64'))
}
