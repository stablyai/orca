import type { MobileE2EEV2Hello, MobileE2EEV2Ready } from './mobile-e2ee-v2-contract'

function repeatedByteBase64(byte: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
}

export function createMobileE2EEV2Fixture(): {
  hello: MobileE2EEV2Hello
  ready: MobileE2EEV2Ready
  sharedSecret: Uint8Array
} {
  const context = {
    protocol: 'orca-mobile-e2ee' as const,
    initiator: 'mobile' as const,
    responder: 'desktop' as const,
    transport: 'relay' as const,
    relayHostId: 'AbCdEf0123_-xyZ9'
  }
  return {
    hello: {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: repeatedByteBase64(1),
      clientNonceB64: repeatedByteBase64(2),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context
    },
    ready: {
      type: 'e2ee_ready',
      v: 2,
      desktopPublicKeyB64: repeatedByteBase64(3),
      clientNonceB64: repeatedByteBase64(2),
      desktopNonceB64: repeatedByteBase64(4),
      selection: { framing: 2, payloadKinds: ['text', 'binary'] },
      context
    },
    sharedSecret: new Uint8Array(32).fill(5)
  }
}

export const MOBILE_E2EE_V2_VECTOR = {
  transcriptLength: 1347,
  transcriptHashHex: 'ca6385f8bbf64a223fdd59587bfb67e2373891ce9e6d85ab41df8b7a20a168e3',
  mobileToDesktopKeyHex: 'df17ff534df77fd3a30999f4e6200c8fcedefbb15d369301ca62c3cdfea9559a',
  desktopToMobileKeyHex: '71365fcf8212a6d63caf909ee28de3c8f689682ef298a374136055e0ab1cde4a',
  sessionIdHex: '339ae1f2bdff63481857d2813c2f19dd1f5aa4824705d5e5daeb25dae7b9196e'
} as const
