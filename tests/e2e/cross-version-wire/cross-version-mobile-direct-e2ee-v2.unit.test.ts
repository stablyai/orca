import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello
} from '../../../src/shared/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../src/shared/mobile-e2ee-v2-framing'
import { deriveMobileE2EEV2KeySchedule } from '../../../src/shared/mobile-e2ee-v2-node-key-schedule'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * Updated phones open direct (LAN) sockets with E2EE v2 instead of the legacy hello. The
 * previously released host must accept that handshake on its direct transport, where it does
 * not require v2, and route sealed requests to its RPC handler.
 */
const SUITE_TIMEOUT_MS = 180_000

type ChannelLike = {
  handleRawMessage(raw: string | Uint8Array): void
  onMessage(handler: (plaintext: string, reply: (response: string) => void) => void): void
}
type ChannelConstructor = new (ws: unknown, options: Record<string, unknown>) => ChannelLike

const host = nacl.box.keyPair()
const phone = nacl.box.keyPair()
let ReleasedChannel: ChannelConstructor

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const module = await importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/e2ee-channel.ts')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's E2EEChannel class; a changed shape fails the assertions below.
  ReleasedChannel = module.E2EEChannel as ChannelConstructor
}, SUITE_TIMEOUT_MS)

// Mirrors MobileE2EEV2ClientSession.create({ transport: 'direct' }) in mobile/.
function directHello(): MobileE2EEV2Hello {
  return {
    type: 'e2ee_hello',
    v: 2,
    clientPublicKeyB64: Buffer.from(phone.publicKey).toString('base64'),
    clientNonceB64: Buffer.from(nacl.randomBytes(32)).toString('base64'),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: {
      protocol: 'orca-mobile-e2ee',
      initiator: 'mobile',
      responder: 'desktop',
      transport: 'direct'
    }
  }
}

describe('cross-version: updated phone dials a released host over direct v2', () => {
  it('authenticates with the device token and round-trips a sealed request', () => {
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
    const channel = new ReleasedChannel(ws, {
      serverSecretKey: host.secretKey,
      resolveAuthenticatedDevice: (token: string) =>
        token === 'device-token'
          ? { deviceId: 'device-1', deviceToken: token, scope: 'mobile' }
          : null,
      onReady,
      onError
    })

    const hello = directHello()
    channel.handleRawMessage(JSON.stringify(hello))
    const ready: unknown = JSON.parse(String(sent[0]))
    const handshake = validateMobileE2EEV2Handshake(hello, ready)
    expect(handshake).not.toBeNull()
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: nacl.box.before(host.publicKey, phone.secretKey),
      transcript: encodeMobileE2EEV2Transcript(handshake!),
      clientNonce: handshake!.clientNonce,
      desktopNonce: handshake!.desktopNonce
    })
    const transcriptHashB64 = Buffer.from(schedule.transcriptHash).toString('base64')
    let outbound = 0n
    let inbound = 0n
    const seal = (text: string) =>
      Buffer.from(
        sealMobileE2EEV2Frame({
          payload: new TextEncoder().encode(text),
          key: schedule.mobileToDesktopKey,
          sessionId: schedule.sessionId,
          direction: 'mobile-to-desktop',
          payloadKind: 'text',
          counter: outbound++
        })
      ).toString('base64')
    const open = (frame: string | Uint8Array) =>
      new TextDecoder().decode(
        openMobileE2EEV2Frame({
          frame: Buffer.from(String(frame), 'base64'),
          key: schedule.desktopToMobileKey,
          sessionId: schedule.sessionId,
          direction: 'desktop-to-mobile',
          payloadKind: 'text',
          expectedCounter: inbound++
        })!
      )

    channel.handleRawMessage(
      seal(
        JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, deviceToken: 'device-token' })
      )
    )
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledOnce()
    expect(JSON.parse(open(sent[1]!))).toEqual({
      type: 'e2ee_authenticated',
      v: 2,
      transcriptHashB64
    })

    channel.onMessage((plaintext, reply) => {
      const request: unknown = JSON.parse(plaintext)
      const id = request && typeof request === 'object' && 'id' in request ? request.id : null
      reply(JSON.stringify({ id, ok: true, result: { echoed: true } }))
    })
    channel.handleRawMessage(seal(JSON.stringify({ id: 'r1', method: 'status.get' })))
    expect(JSON.parse(open(sent[2]!))).toEqual({ id: 'r1', ok: true, result: { echoed: true } })
  })
})
