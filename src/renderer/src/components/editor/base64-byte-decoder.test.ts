// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { decodeBase64Bytes } from './base64-byte-decoder'

describe('decodeBase64Bytes', () => {
  it('decodes large and whitespace-delimited input without changing bytes', () => {
    const expected = new Uint8Array(40_000).map((_, index) => index % 251)
    const encoded = btoa(String.fromCharCode(...expected)).replace(/.{100}/g, '$&\n')

    expect(decodeBase64Bytes(encoded)).toEqual(expected)
  })
})
