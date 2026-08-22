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
    protocol: 'mcode-mobile-e2ee' as const,
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
  transcriptLength: 1350,
  transcriptHashHex: '5ef843b7a9e31730124e230ab036fb78e249e560aecb15b1bbce62b640d953be',
  mobileToDesktopKeyHex: '54746ebe28133c32b2e303c4dc449041069b43a76b85bba90c777646cef719b6',
  desktopToMobileKeyHex: '52d18cbc6b092513d5eba8f9dc4ebeca15290161946723d06ff5f3c89c90840b',
  sessionIdHex: '7938a62d2384f9b9897181840a4164c9c87f8f1a8076b5eebdb9dbd0f49256e3'
} as const
