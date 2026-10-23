import type { SecretboxOpen } from './mobile-e2ee-v2-framing'

// Why: desktop/CLI (Node), web and mobile each keep their own NaCl box and
// base64 adapters (size limits, Hermes typed-array quirks, no Buffer in a
// browser), so the shared handshake core takes them as a parameter.
export type PairedE2EEKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

export type PairedE2EEV2KeySchedule = {
  mobileToDesktopKey: Uint8Array
  desktopToMobileKey: Uint8Array
  sessionId: Uint8Array
  transcriptHash: Uint8Array
}

export type PairedE2EEPrimitives = {
  generateKeyPair: () => PairedE2EEKeyPair
  deriveSharedKey: (ourSecretKey: Uint8Array, peerPublicKey: Uint8Array) => Uint8Array
  randomBytes: (length: number) => Uint8Array
  encodeBase64: (bytes: Uint8Array) => string
  // Throws on input the platform decoder rejects.
  decodeBase64: (value: string) => Uint8Array
  publicKeyFromBase64: (value: string) => Uint8Array
  publicKeyToBase64: (key: Uint8Array) => string
  sealLegacyText: (plaintext: string, sharedKey: Uint8Array) => string
  openLegacyText: (frame: string, sharedKey: Uint8Array) => string | null
  sealLegacyBinary: (plaintext: Uint8Array, sharedKey: Uint8Array) => Uint8Array<ArrayBuffer>
  openLegacyBinary: (frame: Uint8Array, sharedKey: Uint8Array) => Uint8Array | null
  // Why optional: only the phone swaps these, for native code on every inbound v2 frame, since
  // Hermes JS is ~100x slower than V8. Absent, the session uses tweetnacl, re-encode and TextDecoder.
  openSecretbox?: SecretboxOpen
  // Null for anything but canonical padded base64.
  decodeCanonicalBase64?: (value: string) => Uint8Array | null
  decodeUtf8?: (bytes: Uint8Array) => string
  // Why injected: Node uses node:crypto, so the CLI's unbundled runtime needs no extra package.
  deriveV2KeySchedule: (args: {
    sharedSecret: Uint8Array
    transcript: Uint8Array
    clientNonce: Uint8Array
    desktopNonce: Uint8Array
  }) => PairedE2EEV2KeySchedule
}
