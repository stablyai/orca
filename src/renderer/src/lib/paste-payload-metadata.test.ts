import { describe, expect, it, vi } from 'vitest'

import {
  countPastePayloadLines,
  getPastePayloadUtf8ByteLength,
  hasPastePayloadControlSequence,
  measurePastePayloadMetadata,
  measurePastePayloadMetadataWithYield
} from './paste-payload-metadata'
import { PASTE_PAYLOAD_CORPUS } from './paste-payload-corpus'

const textEncoder = new TextEncoder()

describe('paste payload metadata', () => {
  it('matches the shared paste payload corpus', () => {
    for (const { expected, name, text } of PASTE_PAYLOAD_CORPUS) {
      expect(measurePastePayloadMetadata(text), name).toEqual({
        byteLength: textEncoder.encode(text).byteLength,
        exceededLimit: false,
        hasControlSequences: expected.hasControlSequences,
        lineCount: expected.lineCount
      })
    }
  })

  it('measures bytes, logical lines, and control-sequence flags in one pass', () => {
    const text = 'alpha\r\nbeta\ngamma😀\x1b[31m'

    expect(measurePastePayloadMetadata(text)).toEqual({
      byteLength: 26,
      exceededLimit: false,
      hasControlSequences: true,
      lineCount: 3
    })
    expect(getPastePayloadUtf8ByteLength(text)).toBe(26)
    expect(countPastePayloadLines(text)).toBe(3)
    expect(hasPastePayloadControlSequence(text)).toBe(true)
  })

  it('stops measuring when the payload exceeds the configured byte limit', () => {
    const text = ['😀'.repeat(100), 'secret-token'].join('\n')
    const metadata = measurePastePayloadMetadata(text, { stopAfterBytes: 5 })

    expect(metadata).toEqual({
      byteLength: 8,
      exceededLimit: true,
      hasControlSequences: false,
      lineCount: 1
    })
    expect(metadata.byteLength).toBeLessThan(getPastePayloadUtf8ByteLength(text))
  })

  it('yields while measuring accepted large paste metadata', async () => {
    const yieldToEventLoop = vi.fn(async () => {})
    const metadata = await measurePastePayloadMetadataWithYield(
      `${'x'.repeat(32)}\r\nnext\x1b[31m`,
      {
        yieldAfterCodeUnits: 8,
        yieldToEventLoop
      }
    )

    expect(metadata).toEqual({
      byteLength: 43,
      exceededLimit: false,
      hasControlSequences: true,
      lineCount: 2
    })
    expect(yieldToEventLoop).toHaveBeenCalled()
  })
})
