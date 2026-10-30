import { describe, expect, it } from 'vitest'
import type { LocalLogTailReadResult } from '../../../../shared/local-log-tail-types'
import { LocalLogTailDecoder, LOCAL_LOG_TAIL_MAX_BYTES } from './local-log-tail-decoder'

const IDENTITY = '1:2:3'

function chunk(
  content: Uint8Array,
  nextByteOffset: number,
  overrides: Partial<LocalLogTailReadResult> = {}
): LocalLogTailReadResult {
  return {
    contentBase64: Buffer.from(content).toString('base64'),
    nextByteOffset,
    fileSize: nextByteOffset,
    fileIdentity: IDENTITY,
    hasMore: false,
    reset: false,
    ...overrides
  }
}

describe('LocalLogTailDecoder', () => {
  it('rewinds a snapshot to its last complete line', () => {
    const decoder = new LocalLogTailDecoder('one\ntwo', IDENTITY)

    expect(decoder.initialVisibleContent).toBe('one\n')
    expect(decoder.nextByteOffset).toBe(Buffer.byteLength('one\n'))
  })

  it('carries an incomplete UTF-8 code point and record across reads', () => {
    const decoder = new LocalLogTailDecoder('', IDENTITY)
    const bytes = Buffer.from('{"text":"雪"}\n', 'utf8')
    const split = bytes.indexOf(Buffer.from('雪')) + 1

    const first = decoder.apply(chunk(bytes.subarray(0, split), split, { hasMore: true }))
    const second = decoder.apply(chunk(bytes.subarray(split), bytes.length))

    expect(first).toEqual({ kind: 'append', content: '', hasMore: true })
    expect(second).toEqual({ kind: 'append', content: '{"text":"雪"}\n', hasMore: false })
  })

  it('holds a partial final line until a later append completes it', () => {
    const decoder = new LocalLogTailDecoder('', IDENTITY)
    const firstBytes = Buffer.from('{"partial":')
    const secondBytes = Buffer.from('true}\n')

    expect(decoder.apply(chunk(firstBytes, firstBytes.length))).toMatchObject({ content: '' })
    expect(decoder.apply(chunk(secondBytes, firstBytes.length + secondBytes.length))).toMatchObject(
      { content: '{"partial":true}\n' }
    )
  })

  it('does not apply bytes when the reader detects truncate or rotation', () => {
    const decoder = new LocalLogTailDecoder('old\n', IDENTITY)
    const result = decoder.apply(chunk(new Uint8Array(), 0, { reset: true }))

    expect(result).toEqual({ kind: 'reset' })
  })

  it('scans only newly decoded bytes while a large JSONL record is incomplete', () => {
    const decoder = new LocalLogTailDecoder('', IDENTITY)
    const bytes = Buffer.from('x'.repeat(256 * 1024))
    const frames = 32
    const realLastIndexOf = String.prototype.lastIndexOf
    let scannedCharacters = 0
    let output = ''
    String.prototype.lastIndexOf = function (
      this: string,
      searchString: string,
      position?: number
    ): number {
      scannedCharacters += this.length
      return realLastIndexOf.call(this, searchString, position)
    }
    try {
      for (let frame = 1; frame <= frames; frame += 1) {
        const result = decoder.apply(chunk(bytes, frame * bytes.length))
        if (result.kind === 'append') {
          output += result.content
        }
      }
      const completed = decoder.apply(chunk(Buffer.from('\n'), frames * bytes.length + 1))
      if (completed.kind === 'append') {
        output += completed.content
      }
    } finally {
      String.prototype.lastIndexOf = realLastIndexOf
    }
    expect(output).toBe(`${'x'.repeat(bytes.length * frames)}\n`)
    expect(scannedCharacters).toBeLessThanOrEqual(bytes.length * frames + 1)
  })

  it('preserves exact completed records at every UTF-8 byte boundary', () => {
    const text = '雪🐋\rfirst\n\nα second\r\nlast 🦀\nunfinished'
    const bytes = Buffer.from(text)
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const decoder = new LocalLogTailDecoder('header 雪\nold unfinished', IDENTITY)
      const offset = decoder.nextByteOffset
      const first = decoder.apply(chunk(bytes.subarray(0, cut), offset + cut, { hasMore: true }))
      const second = decoder.apply(chunk(bytes.subarray(cut), offset + bytes.length))
      const completed = decoder.apply(chunk(Buffer.from('\n'), offset + bytes.length + 1))
      const outputs = [first, second, completed]
      expect(outputs.every((output) => output.kind === 'append')).toBe(true)
      expect(
        outputs.map((output) => (output.kind === 'append' ? output.content : '')).join('')
      ).toBe(`${text}\n`)
      expect(decoder.nextByteOffset).toBe(offset + bytes.length + 1)
      expect(decoder.expectedIdentity).toBe(IDENTITY)
    }
  })

  it('leaves pending text and offsets unchanged on reset and size limit', () => {
    const decoder = new LocalLogTailDecoder('', IDENTITY)
    decoder.apply(chunk(Buffer.from('pending'), 7))
    expect(decoder.apply(chunk(Buffer.from('ignored\n'), 0, { reset: true }))).toEqual({
      kind: 'reset'
    })
    expect(decoder.apply(chunk(Buffer.from('ignored\n'), LOCAL_LOG_TAIL_MAX_BYTES + 1))).toEqual({
      kind: 'limit'
    })
    expect(decoder.nextByteOffset).toBe(7)
    expect(decoder.expectedIdentity).toBe(IDENTITY)
    expect(decoder.apply(chunk(Buffer.from('\n'), 8))).toEqual({
      kind: 'append',
      content: 'pending\n',
      hasMore: false
    })
  })
})
