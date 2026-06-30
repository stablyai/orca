import { describe, expect, it, vi } from 'vitest'

import { PASTE_PAYLOAD_CORPUS } from '@/lib/paste-payload-corpus'
import {
  countTerminalPasteLines,
  hasTerminalControlSequence,
  measureTerminalPastePayloadMetadata,
  measureTerminalPastePayloadMetadataWithYield,
  utf8ByteLength
} from './terminal-paste-payload-metadata'

const textEncoder = new TextEncoder()

describe('terminal paste payload metadata', () => {
  it('matches the shared paste payload corpus', () => {
    for (const { expected, name, text } of PASTE_PAYLOAD_CORPUS) {
      expect(measureTerminalPastePayloadMetadata(text), name).toEqual({
        byteLength: textEncoder.encode(text).byteLength,
        exceededLimit: false,
        hasControlSequences: expected.hasControlSequences,
        lineCount: expected.lineCount
      })
    }
  })

  it('measures UTF-8 bytes, logical lines, and terminal controls in one pass', () => {
    const text = 'alpha\r\nbeta\ngamma😀\x1b[31m'

    expect(measureTerminalPastePayloadMetadata(text)).toEqual({
      byteLength: 26,
      exceededLimit: false,
      hasControlSequences: true,
      lineCount: 3
    })
    expect(utf8ByteLength(text)).toBe(26)
    expect(countTerminalPasteLines(text)).toBe(3)
    expect(hasTerminalControlSequence(text)).toBe(true)
  })

  it('stops measuring once an oversized paste exceeds the target limit', () => {
    const text = ['😀'.repeat(100), 'secret-token'].join('\n')
    const metadata = measureTerminalPastePayloadMetadata(text, { stopAfterBytes: 5 })

    expect(metadata).toEqual({
      byteLength: 8,
      exceededLimit: true,
      hasControlSequences: false,
      lineCount: 1
    })
    expect(metadata.byteLength).toBeLessThan(utf8ByteLength(text))
  })

  it('yields while measuring accepted large terminal paste metadata', async () => {
    const yieldToEventLoop = vi.fn(async () => {})
    const metadata = await measureTerminalPastePayloadMetadataWithYield(
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
