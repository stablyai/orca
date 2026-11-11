import { describe, expect, it } from 'vitest'

import {
  countPastePayloadLines,
  getPastePayloadUtf8ByteLength,
  hasPastePayloadControlSequence,
  measurePastePayloadMetadata
} from './paste-payload-metadata'

describe('paste payload metadata', () => {
  it('measures bytes, logical lines, and control-sequence flags in one pass', () => {
    const text = 'alpha\r\nbeta\ngamma😀\x1b[31m'

    expect(measurePastePayloadMetadata(text)).toEqual({
      byteLength: 26,
      exceededLimit: false,
      hasControlSequences: true,
      lineEndingByteLength: 3,
      lineCount: 3
    })
    expect(getPastePayloadUtf8ByteLength(text)).toBe(26)
    expect(countPastePayloadLines(text)).toBe(3)
    expect(hasPastePayloadControlSequence(text)).toBe(true)
  })
})
