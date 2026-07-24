export const MOBILE_E2EE_V2_PROTOCOL = 'orca-mobile-e2ee'
export const MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript'

export type MobileE2EETransport = 'direct' | 'relay'
export type MobileE2EEPayloadKind = 'text' | 'binary'

export type MobileE2EEV2Context = {
  protocol: typeof MOBILE_E2EE_V2_PROTOCOL
  initiator: 'mobile'
  responder: 'desktop'
  transport: MobileE2EETransport
  relayHostId?: string
}

export type MobileE2EEV2Hello = {
  type: 'e2ee_hello'
  v: 2
  clientPublicKeyB64: string
  clientNonceB64: string
  capabilities: { framing: [2]; payloadKinds: ['text', 'binary'] }
  context: MobileE2EEV2Context
}

export type MobileE2EEV2Ready = {
  type: 'e2ee_ready'
  v: 2
  desktopPublicKeyB64: string
  clientNonceB64: string
  desktopNonceB64: string
  selection: { framing: 2; payloadKinds: ['text', 'binary'] }
  context: MobileE2EEV2Context
}

export type MobileE2EEV2Handshake = {
  hello: MobileE2EEV2Hello
  ready: MobileE2EEV2Ready
  clientPublicKey: Uint8Array
  desktopPublicKey: Uint8Array
  clientNonce: Uint8Array
  desktopNonce: Uint8Array
}

const BASE64URL_16_PATTERN = /^[A-Za-z0-9_-]{16}$/

export function validateMobileE2EEV2Handshake(
  helloValue: unknown,
  readyValue: unknown
): MobileE2EEV2Handshake | null {
  if (
    !isExactRecord(helloValue, [
      'type',
      'v',
      'clientPublicKeyB64',
      'clientNonceB64',
      'capabilities',
      'context'
    ])
  ) {
    return null
  }
  if (
    !isExactRecord(readyValue, [
      'type',
      'v',
      'desktopPublicKeyB64',
      'clientNonceB64',
      'desktopNonceB64',
      'selection',
      'context'
    ])
  ) {
    return null
  }
  if (helloValue.type !== 'e2ee_hello' || helloValue.v !== 2) {
    return null
  }
  if (readyValue.type !== 'e2ee_ready' || readyValue.v !== 2) {
    return null
  }
  if (!hasExactCapabilities(helloValue.capabilities) || !hasExactSelection(readyValue.selection)) {
    return null
  }
  const helloContext = parseContext(helloValue.context)
  const readyContext = parseContext(readyValue.context)
  if (!helloContext || !readyContext || !contextsEqual(helloContext, readyContext)) {
    return null
  }
  if (readyValue.clientNonceB64 !== helloValue.clientNonceB64) {
    return null
  }

  const clientPublicKey = decodeCanonicalBase64Bytes(helloValue.clientPublicKeyB64, 32)
  const desktopPublicKey = decodeCanonicalBase64Bytes(readyValue.desktopPublicKeyB64, 32)
  const clientNonce = decodeCanonicalBase64Bytes(helloValue.clientNonceB64, 32)
  const desktopNonce = decodeCanonicalBase64Bytes(readyValue.desktopNonceB64, 32)
  if (!clientPublicKey || !desktopPublicKey || !clientNonce || !desktopNonce) {
    return null
  }

  return {
    hello: helloValue as MobileE2EEV2Hello,
    ready: readyValue as MobileE2EEV2Ready,
    clientPublicKey,
    desktopPublicKey,
    clientNonce,
    desktopNonce
  }
}

export function encodeMobileE2EEV2Transcript(handshake: MobileE2EEV2Handshake): Uint8Array {
  const { hello, ready } = handshake
  const fields: [string, Uint8Array][] = [
    ['domain', utf8(MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN)],
    ['mobile-to-desktop.type', utf8(hello.type)],
    ['mobile-to-desktop.version', uint32(hello.v)],
    ['mobile-to-desktop.client-public-key', handshake.clientPublicKey],
    ['mobile-to-desktop.client-nonce', handshake.clientNonce],
    ['mobile-to-desktop.capabilities.framing', encodeNumberList(hello.capabilities.framing)],
    [
      'mobile-to-desktop.capabilities.payload-kinds',
      encodeStringList(hello.capabilities.payloadKinds)
    ],
    ['mobile-to-desktop.context.protocol', utf8(hello.context.protocol)],
    ['mobile-to-desktop.context.initiator', utf8(hello.context.initiator)],
    ['mobile-to-desktop.context.responder', utf8(hello.context.responder)],
    ['mobile-to-desktop.context.transport', utf8(hello.context.transport)],
    ['mobile-to-desktop.context.relay-host-id', utf8(hello.context.relayHostId ?? '')],
    ['desktop-to-mobile.type', utf8(ready.type)],
    ['desktop-to-mobile.version', uint32(ready.v)],
    ['desktop-to-mobile.desktop-public-key', handshake.desktopPublicKey],
    ['desktop-to-mobile.client-nonce-echo', handshake.clientNonce],
    ['desktop-to-mobile.desktop-nonce', handshake.desktopNonce],
    ['desktop-to-mobile.selection.framing', uint32(ready.selection.framing)],
    ['desktop-to-mobile.selection.payload-kinds', encodeStringList(ready.selection.payloadKinds)],
    ['desktop-to-mobile.context.protocol', utf8(ready.context.protocol)],
    ['desktop-to-mobile.context.initiator', utf8(ready.context.initiator)],
    ['desktop-to-mobile.context.responder', utf8(ready.context.responder)],
    ['desktop-to-mobile.context.transport', utf8(ready.context.transport)],
    ['desktop-to-mobile.context.relay-host-id', utf8(ready.context.relayHostId ?? '')]
  ]
  return concatBytes(
    fields.map(([name, value]) =>
      concatBytes([uint32(utf8(name).length), utf8(name), uint32(value.length), value])
    )
  )
}

function parseContext(value: unknown): MobileE2EEV2Context | null {
  if (!isRecord(value)) {
    return null
  }
  const transport = value.transport
  const keys =
    transport === 'relay'
      ? ['protocol', 'initiator', 'responder', 'transport', 'relayHostId']
      : ['protocol', 'initiator', 'responder', 'transport']
  if (!isExactRecord(value, keys)) {
    return null
  }
  if (
    value.protocol !== MOBILE_E2EE_V2_PROTOCOL ||
    value.initiator !== 'mobile' ||
    value.responder !== 'desktop' ||
    (transport !== 'direct' && transport !== 'relay')
  ) {
    return null
  }
  if (
    transport === 'relay' &&
    (typeof value.relayHostId !== 'string' || !BASE64URL_16_PATTERN.test(value.relayHostId))
  ) {
    return null
  }
  return value as MobileE2EEV2Context
}

function hasExactCapabilities(value: unknown): boolean {
  return (
    isExactRecord(value, ['framing', 'payloadKinds']) &&
    Array.isArray(value.framing) &&
    value.framing.length === 1 &&
    value.framing[0] === 2 &&
    Array.isArray(value.payloadKinds) &&
    value.payloadKinds.length === 2 &&
    value.payloadKinds[0] === 'text' &&
    value.payloadKinds[1] === 'binary'
  )
}

function hasExactSelection(value: unknown): boolean {
  return (
    isExactRecord(value, ['framing', 'payloadKinds']) &&
    value.framing === 2 &&
    Array.isArray(value.payloadKinds) &&
    value.payloadKinds.length === 2 &&
    value.payloadKinds[0] === 'text' &&
    value.payloadKinds[1] === 'binary'
  )
}

function contextsEqual(left: MobileE2EEV2Context, right: MobileE2EEV2Context): boolean {
  return (
    left.protocol === right.protocol &&
    left.initiator === right.initiator &&
    left.responder === right.responder &&
    left.transport === right.transport &&
    left.relayHostId === right.relayHostId
  )
}

function decodeCanonicalBase64Bytes(value: unknown, length: number): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return bytes.length === length && encodeBase64(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function encodeNumberList(values: readonly number[]): Uint8Array {
  return concatBytes([uint32(values.length), ...values.map(uint32)])
}

function encodeStringList(values: readonly string[]): Uint8Array {
  return concatBytes([
    uint32(values.length),
    ...values.map((value) => {
      const bytes = utf8(value)
      return concatBytes([uint32(bytes.length), bytes])
    })
  ])
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
