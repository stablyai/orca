import { describe, expect, it } from 'vitest'
import type { LocalLogTailReadResult } from '../../../../shared/local-log-tail-types'
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
})
