import { describe, expect, it } from 'vitest'
import { RipgrepFilenameDecoder, RipgrepFilenameEncodingError } from './ripgrep-filename-decoder'

describe('ripgrep filename decoding', () => {
  it('preserves split scalars, BOMs and literal replacement characters', () => {
    const decoder = new RipgrepFilenameDecoder()
    const text = '\uFEFF日本語😀\uFFFD\0'
    let decoded = ''
    for (const byte of Buffer.from(text)) {
      decoded += decoder.decode(Buffer.from([byte]))
    }
    decoder.finish()
    expect(decoded).toBe(text)
  })

  it.each([[0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80]])(
    'refuses invalid filename bytes %j',
    (...bytes) => {
      expect(() => new RipgrepFilenameDecoder().decode(Buffer.from(bytes))).toThrow(
        RipgrepFilenameEncodingError
      )
    }
  )

  it('rejects an incomplete scalar at EOF', () => {
    const decoder = new RipgrepFilenameDecoder()
    expect(decoder.decode(Buffer.from([0xf0, 0x9f]))).toBe('')
    expect(() => decoder.finish()).toThrow('not valid UTF-8')
  })

  it('accepts string fixtures without losing decoder state', () => {
    const decoder = new RipgrepFilenameDecoder()
    expect(decoder.decode('literal-�\0')).toBe('literal-�\0')
    decoder.finish()
  })
})

it('refuses literal WSL backslashes only when Windows translation is required', () => {
  const errors: Error[] = []
  const decoder = new RipgrepFilenameDecoder((error) => errors.push(error), true)
  expect(decoder.decode(Buffer.from('./a\\b.txt\0'))).toBeNull()
  expect(errors[0]?.message).toContain('WSL filenames containing a backslash')
  expect(new RipgrepFilenameDecoder().decode(Buffer.from('./a\\b.txt\0'))).toBe('./a\\b.txt\0')
})
