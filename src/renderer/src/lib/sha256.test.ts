import { describe, expect, it } from 'vitest'
import { sha256 } from './sha256'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('sha256', () => {
  // Standard NIST known-answer vectors.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    ]
  ])('matches the known digest for %j', (input, expected) => {
    expect(hex(sha256(new TextEncoder().encode(input)))).toBe(expected)
  })

  // The whole point of the fallback: it must be byte-identical to crypto.subtle,
  // so a hook hashed on Electron/HTTPS compares equal when re-hashed over HTTP.
  it('matches crypto.subtle SHA-256 across crossing block boundaries', async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200]) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (i * 37 + 11) & 0xff
      }
      const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      expect(hex(sha256(bytes))).toBe(hex(expected))
    }
  })
})
