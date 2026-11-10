import { describe, expect, it } from 'vitest'
import {
  decideWebPairingStartup,
  parseWebPairingInput,
  readPairingInputFromLocation,
  type WebPairingOffer
} from './web-pairing'
import { PAIRING_INPUT_MAX_CHARACTERS } from '../../../shared/remote-runtime/pairing/mobile-pairing-protocol-limits'

describe('web pairing input', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({ ...offer, ...overrides }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('rejects oversized raw codes, URLs, and location queries before parsing', () => {
    const code = encodeOffer()
    const oversizedRawCode = `${code}${' '.repeat(PAIRING_INPUT_MAX_CHARACTERS)}`
    const oversizedQuery = `?pairing=${code}&ignored=${'A'.repeat(PAIRING_INPUT_MAX_CHARACTERS)}`
    const location = { search: oversizedQuery, hash: '' }

    expect(parseWebPairingInput(oversizedRawCode)).toBeNull()
    expect(
      parseWebPairingInput(`orca://pair${oversizedQuery.replace('pairing=', 'code=')}`)
    ).toBeNull()
    expect(readPairingInputFromLocation(location)).toBeNull()
  })

  it('preserves legacy padding and aliases with the same decoded offer', () => {
    const paddedOffer = { ...offer, endpoint: `${offer.endpoint}/` }
    const code = encodeOffer(paddedOffer)
    expect(code.length % 4).toBe(2)
    const alias = `${code.slice(0, -1)}${base64Alias(code.at(-1)!)}`

    expect(parseWebPairingInput(`${code}=`)).toEqual(paddedOffer)
    expect(parseWebPairingInput(`${code}==`)).toEqual(paddedOffer)
    expect(parseWebPairingInput(alias)).toEqual(paddedOffer)
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`orca://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`orca://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })

  it('auto-saves a runtime link only when it targets the saved server', () => {
    const storedEnvironment = {
      id: 'web-1',
      name: 'Home',
      endpoints: [{ endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64 }]
    }
    const samePairing = encodeOffer({ scope: 'runtime', deviceToken: 'fresh-token' })
    const otherPairing = encodeOffer({ scope: 'runtime', endpoint: 'wss://attacker.example' })

    expect(
      decideWebPairingStartup({ initialPairingInput: samePairing, storedEnvironment })
    ).toMatchObject({ kind: 'auto-save-runtime-offer' })
    expect(
      decideWebPairingStartup({ initialPairingInput: otherPairing, storedEnvironment })
    ).toEqual({ kind: 'confirm-replace-saved-server', initialPairingInput: otherPairing })
    expect(
      decideWebPairingStartup({ initialPairingInput: otherPairing, storedEnvironment: null })
    ).toMatchObject({ kind: 'auto-save-runtime-offer' })
  })
})

function base64Alias(character: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return alphabet[alphabet.indexOf(character) + 1]!
}
