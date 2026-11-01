import { describe, expect, it } from 'vitest'
import { decodeBase64Bytes } from './base64-bytes'

describe('base64 byte decoding', () => {
  it.each([0, 1, 2, 3, 256, 257, 258])('preserves every byte for length %i', (length) => {
    const expected = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      expected[index] = index % 256
    }
    const decoded = decodeBase64Bytes(expected.toString('base64'))
    expect(Buffer.from(decoded)).toEqual(expected)
  })

  it('preserves atob support for whitespace and omitted padding', () => {
    expect(decodeBase64Bytes(' /+7d zA\t\r\n')).toEqual(Uint8Array.of(255, 238, 221, 204))
  })

  it.each(['A', 'A===', 'AQ?D', 'AQID='])('rejects malformed base64 %s', (encoded) => {
    expect(() => decodeBase64Bytes(encoded)).toThrow()
  })
})
