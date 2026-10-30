// Pin the plain-JS benchmark E2EE client to the real desktop’s transcript encoding, key schedule and frames, outside React Native.
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { DesktopMobileE2EEV2Session } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import { PhoneE2EE } from './phone-e2ee-v2-session.mjs'

const RELAY_HOST_ID = 'AAAAAAAAAAAAAAAA'

function handshake() {
  const desktopKeys = nacl.box.keyPair()
  const phone = new PhoneE2EE(Buffer.from(desktopKeys.publicKey).toString('base64'), RELAY_HOST_ID)
  const desktop = DesktopMobileE2EEV2Session.create({
    hello: phone.hello,
    serverSecretKey: desktopKeys.secretKey,
    expectedContext: { transport: 'relay', relayHostId: RELAY_HOST_ID }
  })
  return { phone, desktop }
}

describe('bench PhoneE2EE against the desktop E2EE v2 responder', () => {
  it('round-trips the e2ee_auth frame the bench sends', () => {
    const { phone, desktop } = handshake()
    phone.acceptReady(desktop.ready)
    const auth = JSON.stringify({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64: phone.transcriptHashB64,
      deviceToken: 'device-token'
    })
    expect(desktop.openText(phone.sealText(auth))).toBe(auth)
  })

  it('opens the desktop reply and keeps counters in step across frames', () => {
    const { phone, desktop } = handshake()
    phone.acceptReady(desktop.ready)
    expect(phone.openText(desktop.sealText('{"type":"e2ee_authenticated"}'))).toBe(
      '{"type":"e2ee_authenticated"}'
    )
    expect(phone.openText(desktop.sealText('{"id":"b-1","ok":true}'))).toBe(
      '{"id":"b-1","ok":true}'
    )
    const binary = new Uint8Array([1, 2, 3, 4])
    expect(Array.from(phone.open(desktop.sealBinary(binary), 1))).toEqual([1, 2, 3, 4])
    expect(phone.openText(desktop.sealText('{"id":"b-2","ok":true}'))).toBe(
      '{"id":"b-2","ok":true}'
    )
  })

  it('rejects a desktop key it did not pin', () => {
    const { phone, desktop } = handshake()
    const impostor = nacl.box.keyPair()
    expect(() =>
      phone.acceptReady({
        ...desktop.ready,
        desktopPublicKeyB64: Buffer.from(impostor.publicKey).toString('base64')
      })
    ).toThrow(/desktop key mismatch/)
  })
})
