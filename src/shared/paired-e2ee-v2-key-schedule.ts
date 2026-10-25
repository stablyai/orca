import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import type { PairedE2EEV2KeySchedule } from './paired-e2ee-primitives'

// Pure JS preserves shared v2 keys on insecure LAN browsers without crypto.subtle and on Hermes; exclude from the unbundled CLI graph.
const SALT_LABEL = new TextEncoder().encode('orca-mobile-e2ee/v2/salt\0')
const INFO_LABEL = new TextEncoder().encode('orca-mobile-e2ee/v2/session\0')

export function derivePairedE2EEV2KeySchedule(args: {
  sharedSecret: Uint8Array
  transcript: Uint8Array
  clientNonce: Uint8Array
  desktopNonce: Uint8Array
}): PairedE2EEV2KeySchedule {
  requireLength(args.sharedSecret, 32, 'shared secret')
  requireLength(args.clientNonce, 32, 'client nonce')
  requireLength(args.desktopNonce, 32, 'desktop nonce')

  const transcriptHash = sha256(args.transcript)
  const salt = sha256(concatBytes([SALT_LABEL, args.clientNonce, args.desktopNonce]))
  const info = concatBytes([INFO_LABEL, transcriptHash])
  const expanded = hkdf(sha256, args.sharedSecret, salt, info, 96)
  return {
    mobileToDesktopKey: expanded.slice(0, 32),
    desktopToMobileKey: expanded.slice(32, 64),
    sessionId: expanded.slice(64, 96),
    transcriptHash
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function requireLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new Error(`Invalid ${label}: expected ${expected} bytes, got ${bytes.length}`)
  }
}
