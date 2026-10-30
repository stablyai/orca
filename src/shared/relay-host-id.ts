import { createHash } from 'node:crypto'

export function deriveRelayHostId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}
