import { describe, expect, it } from 'vitest'
import type { LocalLogTailReadResult } from '../../../../../../shared/local-log-tail-types'
import { LocalLogTailDecoder } from './local-log-tail-decoder'

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
    }
  })
})
