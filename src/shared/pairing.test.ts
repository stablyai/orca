import { describe, expect, it } from 'vitest'
import {
  encodePairingOffer,
  decodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from './pairing'

describe('pairing offer', () => {
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'abcdef1234567890abcdef1234567890abcdef1234567890',
    publicKeyB64: 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NC1lbmNvZGVk'
  }

  it('encode then decode round-trips correctly', () => {
    const url = encodePairingOffer(offer)
    expect(url).toMatch(/^orca:\/\/pair#/)

    const decoded = decodePairingOffer(url)
    expect(decoded).toEqual(offer)
  })

  it('encoded URL uses base64url (no +, /, or = characters)', () => {
    const url = encodePairingOffer(offer)
    const fragment = url.split('#')[1]!
    expect(fragment).not.toMatch(/[+/=]/)
  })

  it('rejects URLs with wrong scheme', () => {
    expect(() => decodePairingOffer('https://example.com#abc')).toThrow('Invalid pairing URL')
  })

  it('rejects URLs without fragment', () => {
    expect(() => decodePairingOffer('orca://pair')).toThrow('Invalid pairing URL')
  })

  it('rejects payloads with missing fields', () => {
    const partial = { v: 2, endpoint: 'ws://host:1234' }
    const base64 = Buffer.from(JSON.stringify(partial)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })

  it('rejects payloads with wrong version', () => {
    const wrong = { ...offer, v: 1 }
    const base64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })

  it('rejects payloads with missing publicKeyB64', () => {
    const wrong = { v: 2, endpoint: 'ws://host:1234', deviceToken: 'tok' }
    const base64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })
})

describe('parsePairingCode', () => {
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'token-abc',
    publicKeyB64: 'pubkey-xyz'
  }

  it('parses a full orca://pair# URL', () => {
    const url = encodePairingOffer(offer)
    expect(parsePairingCode(url)).toEqual(offer)
  })

  it('parses a bare base64url payload (without scheme prefix)', () => {
    const url = encodePairingOffer(offer)
    const base64url = url.split('#')[1]!
    expect(parsePairingCode(base64url)).toEqual(offer)
  })

  it('tolerates surrounding whitespace from clipboard', () => {
    const url = encodePairingOffer(offer)
    expect(parsePairingCode(`  ${url}\n`)).toEqual(offer)
  })

  it('returns null for empty input', () => {
    expect(parsePairingCode('')).toBeNull()
    expect(parsePairingCode('   ')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(parsePairingCode('not a pairing code')).toBeNull()
    expect(parsePairingCode('https://example.com')).toBeNull()
  })

  it('returns null for valid base64 of unrelated JSON', () => {
    const bogus = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64')
    expect(parsePairingCode(bogus)).toBeNull()
  })
})
