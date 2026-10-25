import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { E2EEChannel as CurrentChannel } from '../../../src/main/runtime/rpc/e2ee-channel'
import { createPairedE2EEClientHandshake } from '../../../src/shared/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../src/shared/paired-e2ee-node-primitives'
import { remoteRuntimeClientCapabilities } from '../../../src/shared/remote-runtime-client-capabilities'
import type { MOBILE_E2EE_LEGACY_FIXTURE } from '../../../src/shared/mobile-e2ee-legacy-fixtures'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Shared handshake-core refactoring must preserve authentication in both directions against real released peers.
const SUITE_TIMEOUT_MS = 180_000

type ChannelLike = {
  handleRawMessage(raw: string | Uint8Array): void
  onMessage(handler: (plaintext: string, reply: (response: string) => void) => void): void
  destroy(): void
}
type ChannelConstructor = new (ws: unknown, options: Record<string, unknown>) => ChannelLike
type ReleasedCrypto = {
  generateKeyPair: () => nacl.BoxKeyPair
  deriveSharedKey: (secretKey: Uint8Array, publicKey: Uint8Array) => Uint8Array
  encrypt: (plaintext: string, sharedKey: Uint8Array) => string
  decrypt: (frame: string, sharedKey: Uint8Array) => string | null
}

const CurrentChannelConstructor =
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the current E2EEChannel accepts the fake socket and the superset resolver below.
  CurrentChannel as unknown as ChannelConstructor
const host = nacl.box.keyPair()
const hostPublicKeyB64 = Buffer.from(host.publicKey).toString('base64')
let ReleasedChannel: ChannelConstructor
let releasedCrypto: ReleasedCrypto
let releasedLegacyFixture: typeof MOBILE_E2EE_LEGACY_FIXTURE

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const channelModule = await importReleaseCheckoutModule(
    checkout,
    'src/main/runtime/rpc/e2ee-channel.ts'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's E2EEChannel class; a changed shape fails the assertions below.
  ReleasedChannel = channelModule.E2EEChannel as ChannelConstructor
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's shared NaCl helpers; a changed shape fails the round trips below.
  releasedCrypto = (await importReleaseCheckoutModule(
    checkout,
    'src/shared/e2ee-crypto.ts'
  )) as unknown as ReleasedCrypto
  const fixtureModule = await importReleaseCheckoutModule(
    checkout,
    'src/shared/mobile-e2ee-legacy-fixtures.ts'
  )
  const fixture = fixtureModule.MOBILE_E2EE_LEGACY_FIXTURE
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's captured legacy frames; a changed shape fails the byte comparisons below.
  releasedLegacyFixture = fixture as typeof MOBILE_E2EE_LEGACY_FIXTURE
}, SUITE_TIMEOUT_MS)

function hostChannel(Channel: ChannelConstructor) {
  const sent: (string | Uint8Array)[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: string | Uint8Array) => sent.push(data)),
    close: vi.fn()
  }
  const onReady = vi.fn()
  const onError = vi.fn()
  const channel = new Channel(ws, {
    serverSecretKey: host.secretKey,
    // Both the released and the current resolver shapes; each host reads the fields it knows.
    resolveAuthenticatedDevice: (token: string) =>
      token === 'device-token'
        ? {
            deviceId: 'device-1',
            deviceToken: token,
            scope: 'runtime',
            clientId: 'device-1',
            callerFingerprint: 'fingerprint',
            credentialRevision: 0
          }
        : null,
    onReady,
    onError
  })
  channel.onMessage((plaintext, reply) => {
    const request: unknown = JSON.parse(plaintext)
    const id = request && typeof request === 'object' && 'id' in request ? request.id : null
    reply(JSON.stringify({ id, ok: true, result: { echoed: true } }))
  })
  return { channel, sent, onReady, onError }
}

async function coreClientRoundTrip(
  Channel: ChannelConstructor,
  framing: 'legacy' | 'v2'
): Promise<void> {
  const { channel, sent, onReady, onError } = hostChannel(Channel)
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64,
    framing,
    transport: 'direct'
  })
  channel.handleRawMessage(handshake.helloText())
  expect(handshake.acceptReadyText(String(sent[0]))).toBe('accepted')
  channel.handleRawMessage(
    await handshake.sealAuth(
      { kind: 'token', deviceToken: 'device-token' },
      framing === 'legacy' ? { clientCapabilities: remoteRuntimeClientCapabilities() } : undefined
    )
  )
  expect(onError).not.toHaveBeenCalled()
  expect(onReady).toHaveBeenCalledOnce()
  const authenticated = handshake.channel.openText(String(sent[1]))
  expect(handshake.classifyAuthReply(authenticated!)).toEqual({
    kind: 'authenticated'
  })

  channel.handleRawMessage(
    handshake.channel.sealText(JSON.stringify({ id: 'r1', method: 'status.get' }))
  )
  expect(JSON.parse(handshake.channel.openText(String(sent[2]))!)).toEqual({
    id: 'r1',
    ok: true,
    result: { echoed: true }
  })
  channel.destroy()
}

describe('cross-version: shared paired E2EE handshake core', () => {
  it('writes the frames the released client wrote', async () => {
    const fixture = releasedLegacyFixture
    const handshake = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: fixture.serverPublicKeyB64,
      framing: 'legacy',
      clientKeyPair: nacl.box.keyPair.fromSecretKey(fixture.clientSecretKey)
    })
    expect(handshake.helloText()).toBe(fixture.helloText)
    const randomBytes = vi
      .spyOn(nacl, 'randomBytes')
      .mockImplementation((length) => new Uint8Array(length).fill(6))
    try {
      expect(
        await handshake.sealAuth({
          kind: 'token',
          deviceToken: 'legacy-token'
        })
      ).toBe(fixture.authFrameB64)
    } finally {
      randomBytes.mockRestore()
    }
  })

  it('authenticates against the released host with legacy runtime framing', async () => {
    await coreClientRoundTrip(ReleasedChannel, 'legacy')
  })

  it('authenticates against the released host with direct v2 framing', async () => {
    await coreClientRoundTrip(ReleasedChannel, 'v2')
  })

  it('authenticates against this host with both framings', async () => {
    await coreClientRoundTrip(CurrentChannelConstructor, 'legacy')
    await coreClientRoundTrip(CurrentChannelConstructor, 'v2')
  })

  it('keeps the released runtime client authenticating against this host', () => {
    const { channel, sent, onReady, onError } = hostChannel(CurrentChannelConstructor)
    const client = releasedCrypto.generateKeyPair()
    const sharedKey = releasedCrypto.deriveSharedKey(client.secretKey, host.publicKey)
    // The released runtime transports wrote exactly this hello and auth.
    channel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(client.publicKey).toString('base64')
      })
    )
    expect(JSON.parse(String(sent[0]))).toEqual({ type: 'e2ee_ready' })
    channel.handleRawMessage(
      releasedCrypto.encrypt(
        JSON.stringify({
          type: 'e2ee_auth',
          deviceToken: 'device-token',
          clientCapabilities: remoteRuntimeClientCapabilities()
        }),
        sharedKey
      )
    )
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()
    expect(JSON.parse(releasedCrypto.decrypt(String(sent[1]), sharedKey)!)).toEqual({
      type: 'e2ee_authenticated'
    })
    channel.handleRawMessage(
      releasedCrypto.encrypt(JSON.stringify({ id: 'r1', method: 'status.get' }), sharedKey)
    )
    expect(JSON.parse(releasedCrypto.decrypt(String(sent[2]), sharedKey)!)).toMatchObject({
      id: 'r1',
      ok: true
    })
    channel.destroy()
  })
})
