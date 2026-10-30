import { describe, expect, it } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from './mobile-e2ee-v2-contract'
import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './mobile-e2ee-v2-fixtures'
import { derivePairedE2EEV2KeySchedule } from './paired-e2ee-v2-key-schedule'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-node-key-schedule'

describe('desktop mobile E2EE v2 key schedule', () => {
  it('derives the normative 96-byte HKDF vector', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })

    expect(Buffer.from(schedule.mobileToDesktopKey).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex
    )
    expect(Buffer.from(schedule.desktopToMobileKey).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex
    )
    expect(Buffer.from(schedule.sessionId).toString('hex')).toBe(MOBILE_E2EE_V2_VECTOR.sessionIdHex)
    expect(Buffer.from(schedule.transcriptHash).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.transcriptHashHex
    )
  })

  it('derives unique direction keys and session IDs across fresh desktop nonces', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const mobileKeys = new Set<string>()
    const desktopKeys = new Set<string>()
    const sessions = new Set<string>()
    for (let index = 0; index < 128; index++) {
      const nonce = Buffer.alloc(32)
      nonce.writeUInt32BE(index, 28)
      const handshake = validateMobileE2EEV2Handshake(hello, {
        ...ready,
        desktopNonceB64: nonce.toString('base64')
      })!
      const schedule = deriveMobileE2EEV2KeySchedule({
        sharedSecret,
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      })
      mobileKeys.add(Buffer.from(schedule.mobileToDesktopKey).toString('hex'))
      desktopKeys.add(Buffer.from(schedule.desktopToMobileKey).toString('hex'))
      sessions.add(Buffer.from(schedule.sessionId).toString('hex'))
      expect(schedule.mobileToDesktopKey).not.toEqual(schedule.desktopToMobileKey)
    }
    expect(mobileKeys.size).toBe(128)
    expect(desktopKeys.size).toBe(128)
    expect(sessions.size).toBe(128)
  })

  it('matches the pure-JS client schedule across fresh desktop nonces', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    for (let index = 0; index < 16; index++) {
      const nonce = Buffer.alloc(32)
      nonce.writeUInt32BE(index, 28)
      const handshake = validateMobileE2EEV2Handshake(hello, {
        ...ready,
        desktopNonceB64: nonce.toString('base64')
      })!
      const input = {
        sharedSecret,
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      }
      expect(derivePairedE2EEV2KeySchedule(input)).toEqual(deriveMobileE2EEV2KeySchedule(input))
    }
  })
})
