import { sha256 } from './sha256'

/** An orca.yaml script's trust hash: SHA-256 hex of its trimmed text, as hosts compute it. */
export function hashOrcaHookContent(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content.trim())))
}

export function bytesToHex(view: Uint8Array): string {
  let hex = ''
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}
