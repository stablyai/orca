import { describe, expect, it } from 'vitest'
import { decodeBase64ToBytes } from './base64-bytes'

describe('decodeBase64ToBytes', () => {
  it('decodes standard base64 to the original bytes', () => {
    expect(decodeBase64ToBytes(Buffer.from('hello').toString('base64'))).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    )
  })

  it('round-trips every byte value', () => {
    const original = new Uint8Array(256)
    for (let index = 0; index < original.length; index += 1) {
      original[index] = index
    }

    expect(decodeBase64ToBytes(Buffer.from(original).toString('base64'))).toEqual(original)
  })

  it('decodes payloads at each padding length', () => {
    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      expect(decodeBase64ToBytes(Buffer.from(text).toString('base64'))).toEqual(
        new Uint8Array(Buffer.from(text))
      )
    }
  })

  it('ignores the newlines a line-wrapped payload carries', () => {
    const wrapped = Buffer.from('the quick brown fox')
      .toString('base64')
      .replace(/(.{4})/g, '$1\n')

    expect(decodeBase64ToBytes(wrapped)).toEqual(new Uint8Array(Buffer.from('the quick brown fox')))
  })

  it('accepts the URL-safe alphabet', () => {
    const bytes = new Uint8Array([251, 255, 190])
    const urlSafe = Buffer.from(bytes).toString('base64url')

    expect(urlSafe).toContain('_')
    expect(decodeBase64ToBytes(urlSafe)).toEqual(bytes)
  })

  it('returns an empty array for empty input', () => {
    expect(decodeBase64ToBytes('')).toEqual(new Uint8Array(0))
  })

  it('throws on input that is not base64 at all', () => {
    expect(() => decodeBase64ToBytes('!!!!')).toThrow()
  })
})
