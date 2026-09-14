import { describe, expect, it } from 'vitest'
import { epubBase64ToArrayBuffer } from './epub-base64-to-array-buffer'

describe('epubBase64ToArrayBuffer', () => {
  it('decodes base64 into the original bytes', () => {
    // "PK" — the ZIP local-file-header magic every epub starts with.
    const base64 = 'UEsDBA=='
    const bytes = new Uint8Array(epubBase64ToArrayBuffer(base64))
    expect(Array.from(bytes)).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('ignores embedded whitespace/newlines in the base64 payload', () => {
    const bytes = new Uint8Array(epubBase64ToArrayBuffer('UEsD\nBA ==\t'))
    expect(Array.from(bytes)).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('throws a clear error on undecodable input', () => {
    expect(() => epubBase64ToArrayBuffer('@@@not-base64@@@')).toThrow(/decode/i)
  })
})
