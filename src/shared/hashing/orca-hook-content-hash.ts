import { bytesToHex, sha256 } from './sha256'

/** An orca.yaml script's trust hash: SHA-256 hex of its trimmed text, as hosts compute it. */
export function hashOrcaHookContent(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content.trim())))
}

/** Pins "no shared setup": a create carrying it skips any setup the created branch adds. */
export const EMPTY_ORCA_HOOK_CONTENT_HASH = hashOrcaHookContent('')

export { bytesToHex } from './sha256'
