import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_E2EE_LEGACY_FIXTURE as LEGACY } from './mobile-e2ee-legacy-fixtures'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from './mobile-e2ee-v2-contract'
import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './mobile-e2ee-v2-fixtures'
import { openMobileE2EEV2Frame, sealMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'
import {
  createPairedE2EEClientHandshake,
  PairedE2EEDowngradeError
} from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './paired-e2ee-node-primitives'
import { derivePairedE2EEV2KeySchedule } from './paired-e2ee-v2-key-schedule'

const server = nacl.box.keyPair.fromSecretKey(LEGACY.serverSecretKey)
const client = nacl.box.keyPair.fromSecretKey(LEGACY.clientSecretKey)
const token = { kind: 'token', deviceToken: 'legacy-token' } as const

function legacyHandshake(mayUseLegacy = () => true) {
  return createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64: LEGACY.serverPublicKeyB64,
    framing: 'legacy',
    clientKeyPair: client,
    legacyGate: { mayUseLegacy }
  })
}

function fixedNonce(byte: number): void {
  vi.spyOn(nacl, 'randomBytes').mockImplementation((length) => new Uint8Array(length).fill(byte))
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('paired E2EE client handshake: legacy framing', () => {
  it('writes the captured legacy hello, auth and binary bytes', async () => {
    const handshake = legacyHandshake()
    expect(handshake.helloText()).toBe(LEGACY.helloText)
    expect(handshake.acceptReadyText(LEGACY.readyText)).toBe('accepted')

    fixedNonce(6)
    expect(await handshake.sealAuth(token)).toBe(LEGACY.authFrameB64)
    expect(hex(handshake.channel.sealBinary(LEGACY.binaryPlaintext))).toBe(LEGACY.binaryFrameHex)
  })

  it('keeps the runtime auth shape, capabilities last', async () => {
    const handshake = legacyHandshake()
    const frame = await handshake.sealAuth(token, { clientCapabilities: ['a.v1', 'b.v1'] })
    const shared = nacl.box.before(client.publicKey, server.secretKey)
    const bundle = Buffer.from(frame, 'base64')
    const plaintext = nacl.box.open.after(bundle.subarray(24), bundle.subarray(0, 24), shared)
    expect(Buffer.from(plaintext!).toString()).toBe(
      '{"type":"e2ee_auth","deviceToken":"legacy-token","clientCapabilities":["a.v1","b.v1"]}'
    )
  })

  it('opens host frames and rejects tampered ones', () => {
    const handshake = legacyHandshake()
    const shared = nacl.box.before(client.publicKey, server.secretKey)
    const nonce = new Uint8Array(24).fill(7)
    const sealed = nacl.box.after(
      new TextEncoder().encode('{"type":"e2ee_authenticated"}'),
      nonce,
      shared
    )
    const frame = Buffer.concat([nonce, sealed])
    expect(handshake.channel.openText(frame.toString('base64'))).toBe(
      '{"type":"e2ee_authenticated"}'
    )
    frame[30] ^= 1
    expect(handshake.channel.openText(frame.toString('base64'))).toBeNull()
  })

  it('classifies ready frames the way every runtime client did', () => {
    const handshake = legacyHandshake()
    expect(handshake.acceptReadyText('not json')).toBe('invalid')
    expect(handshake.acceptReadyText('null')).toBe('unexpected')
    expect(handshake.acceptReadyText('{"type":"e2ee_error"}')).toBe('unexpected')
    expect(handshake.acceptReadyText('{"type":"e2ee_ready","extra":1}')).toBe('accepted')
  })

  it('refuses a legacy hello, ready or auth once the host is latched to v2', async () => {
    let latched = false
    const handshake = legacyHandshake(() => !latched)
    expect(() => handshake.helloText()).not.toThrow()
    latched = true
    expect(() => handshake.helloText()).toThrow(PairedE2EEDowngradeError)
    expect(handshake.acceptReadyText(LEGACY.readyText)).toBe('downgrade_refused')
    await expect(handshake.sealAuth(token)).rejects.toThrow(PairedE2EEDowngradeError)
  })

  it('classifies auth replies without throwing on non-objects', () => {
    const handshake = legacyHandshake()
    expect(handshake.classifyAuthReply('{"type":"e2ee_authenticated"}')).toEqual({
      kind: 'authenticated'
    })
    expect(handshake.classifyAuthReply('{"ok":false,"error":{"code":"unauthorized"}}')).toEqual({
      kind: 'rejected',
      type: null,
      errorCode: 'unauthorized'
    })
    expect(handshake.classifyAuthReply('{"type":"e2ee_error","code":"bad_auth"}')).toEqual({
      kind: 'rejected',
      type: 'e2ee_error',
      errorCode: null
    })
    expect(handshake.classifyAuthReply('null')).toEqual({
      kind: 'rejected',
      type: null,
      errorCode: null
    })
    expect(handshake.classifyAuthReply('{')).toEqual({ kind: 'invalid' })
  })

  it('surfaces the caller serializer error from the auth step', async () => {
    const handshake = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: LEGACY.serverPublicKeyB64,
      framing: 'legacy',
      serializeJson: () => {
        throw new Error('too large')
      }
    })
    await expect(handshake.sealAuth(token)).rejects.toThrow('too large')
  })
})

describe('paired E2EE client handshake: v2 framing', () => {
  function v2Handshake() {
    const fixture = createMobileE2EEV2Fixture()
    const handshake = createPairedE2EEClientHandshake({
      // Why: the normative vector fixes the ECDH output, not a real key pair.
      primitives: { ...NODE_PAIRED_E2EE_PRIMITIVES, deriveSharedKey: () => fixture.sharedSecret },
      hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
      framing: 'v2',
      transport: 'relay',
      relayHostId: fixture.hello.context.relayHostId,
      clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
      clientNonce: new Uint8Array(32).fill(2)
    })
    return { fixture, handshake }
  }

  it('writes the normative hello and derives the vector transcript', async () => {
    const { fixture, handshake } = v2Handshake()
    expect(handshake.helloText()).toBe(JSON.stringify(fixture.hello))
    expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('accepted')

    const frame = Buffer.from(await handshake.sealAuth(token), 'base64')
    const plaintext = openMobileE2EEV2Frame({
      frame,
      key: Buffer.from(MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex, 'hex'),
      sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      expectedCounter: 0n
    })
    const transcriptHashB64 = Buffer.from(MOBILE_E2EE_V2_VECTOR.transcriptHashHex, 'hex').toString(
      'base64'
    )
    expect(Buffer.from(plaintext!).toString()).toBe(
      JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, deviceToken: 'legacy-token' })
    )
  })

  it('accepts only the authenticated reply that echoes its transcript', () => {
    const { fixture, handshake } = v2Handshake()
    handshake.acceptReadyText(JSON.stringify(fixture.ready))
    const transcriptHashB64 = Buffer.from(MOBILE_E2EE_V2_VECTOR.transcriptHashHex, 'hex').toString(
      'base64'
    )
    const reply = { type: 'e2ee_authenticated', v: 2, transcriptHashB64 }
    expect(handshake.classifyAuthReply(JSON.stringify(reply)).kind).toBe('authenticated')
    expect(
      handshake.classifyAuthReply(JSON.stringify({ ...reply, transcriptHashB64: 'x' })).kind
    ).toBe('rejected')
    expect(handshake.classifyAuthReply(JSON.stringify({ ...reply, extra: 1 })).kind).toBe(
      'rejected'
    )
    expect(handshake.classifyAuthReply('{"type":"e2ee_error","code":"bad_auth"}')).toMatchObject({
      kind: 'rejected',
      type: 'e2ee_error'
    })
  })

  it('refuses a legacy ready and a re-keyed host', () => {
    const { fixture, handshake } = v2Handshake()
    expect(handshake.acceptReadyText(LEGACY.readyText)).toBe('unexpected')
    expect(
      handshake.acceptReadyText(
        JSON.stringify({ ...fixture.ready, desktopPublicKeyB64: LEGACY.serverPublicKeyB64 })
      )
    ).toBe('unexpected')
  })

  it('opens host frames in counter order only', () => {
    const { fixture, handshake } = v2Handshake()
    handshake.acceptReadyText(JSON.stringify(fixture.ready))
    const seal = (text: string, counter: bigint) =>
      Buffer.from(
        sealMobileE2EEV2Frame({
          payload: new TextEncoder().encode(text),
          key: Buffer.from(MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex, 'hex'),
          sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
          direction: 'desktop-to-mobile',
          payloadKind: 'text',
          counter
        })
      ).toString('base64')
    const first = seal('one', 0n)
    expect(handshake.channel.openText(first)).toBe('one')
    expect(handshake.channel.openText(first)).toBeNull()
    expect(handshake.channel.openText(seal('two', 1n))).toBe('two')
  })
})

describe('paired E2EE v2 key schedule', () => {
  it('matches the normative vector byte for byte', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const input = {
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    }
    const client = derivePairedE2EEV2KeySchedule(input)
    expect(hex(client.mobileToDesktopKey)).toBe(MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex)
    expect(hex(client.desktopToMobileKey)).toBe(MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex)
    expect(hex(client.sessionId)).toBe(MOBILE_E2EE_V2_VECTOR.sessionIdHex)
    expect(hex(client.transcriptHash)).toBe(MOBILE_E2EE_V2_VECTOR.transcriptHashHex)
  })
})
