import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode } from './pairing'
import type { PairingOffer } from './mobile-relay-pairing-offer'

describe('pairing offer', () => {
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'abcdef1234567890abcdef1234567890abcdef1234567890',
    publicKeyB64: 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NC1lbmNvZGVk'
  }

  it('preserves partial padding consistently across Node and browser runtimes', () => {
    const url = encodePairingOffer(offer)
    const code = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('code')!
    expect(code.length % 4).toBe(2)
    const malformedCode = `${code}=`
    const nodeDecoded = parsePairingCode(malformedCode)
    const nodeBuffer = Buffer
    let browserDecoded: PairingOffer | null = null
    try {
      vi.stubGlobal('Buffer', undefined)
      browserDecoded = parsePairingCode(malformedCode)
    } finally {
      vi.stubGlobal('Buffer', nodeBuffer)
    }

    expect({ nodeDecoded, browserDecoded }).toEqual({
      nodeDecoded: offer,
      browserDecoded: offer
    })
  })

  it('preserves non-zero pad bits consistently across Node and browser runtimes', () => {
    const url = encodePairingOffer(offer)
    const code = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('code')!
    expect(code.length % 4).toBe(2)
    const alias = `${code.slice(0, -1)}${base64Alias(code.at(-1)!)}`
    const nodeDecoded = parsePairingCode(alias)
    const nodeBuffer = Buffer
    let browserDecoded: PairingOffer | null = null
    try {
      vi.stubGlobal('Buffer', undefined)
      browserDecoded = parsePairingCode(alias)
    } finally {
      vi.stubGlobal('Buffer', nodeBuffer)
    }

    expect({ nodeDecoded, browserDecoded }).toEqual({
      nodeDecoded: offer,
      browserDecoded: offer
    })
  })
})

function base64Alias(character: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return alphabet[alphabet.indexOf(character) + 1]!
}
