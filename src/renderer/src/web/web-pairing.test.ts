import { describe, expect, it } from 'vitest'
import { parseWebPairingInput, type WebPairingOffer } from './web-pairing'

describe('web pairing input', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer() {
    return Buffer.from(JSON.stringify(offer), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('parses query-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('still parses legacy hash-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair#${encodeOffer()}`)).toEqual(offer)
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`orca://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`orca://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })
})
