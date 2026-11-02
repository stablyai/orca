import {
  createPairedE2EEClientHandshake,
  createPairedE2EELegacyChannel,
  type PairedE2EEClientHandshake
} from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './paired-e2ee-node-primitives'

// Fixed legacy shared key lets tests seal host frames without ECDH.
export function createFixedKeyLegacyHandshakeForTest(
  sharedKey: Uint8Array
): PairedE2EEClientHandshake {
  return {
    ...createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
      framing: 'legacy'
    }),
    channel: createPairedE2EELegacyChannel(NODE_PAIRED_E2EE_PRIMITIVES, sharedKey)
  }
}
