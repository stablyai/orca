import { describe, expect, it } from 'vitest'
import {
  containsStatefulRendererQuery,
  extractHiddenStartupRendererQueryData,
  findCsiFinalByteIndex
} from './terminal-reply-query-extraction'

describe('findCsiFinalByteIndex', () => {
  it('returns the final byte of a complete CSI', () => {
    expect(findCsiFinalByteIndex('\x1b[38;2;1;2;3m', 2)).toBe(12)
  })

  it('keeps a CSI with no final byte open', () => {
    expect(findCsiFinalByteIndex('\x1b[38;2;177;1', 2)).toBe(-1)
  })

  it('ends a CSI where ESC, CAN or SUB aborts it, as xterm does', () => {
    // Why: without the abort, the `]` of the next OSC read as this CSI's final byte.
    expect(findCsiFinalByteIndex('\x1b[38;2;177;1\x1b]104;255\x07', 2)).toBe(11)
    expect(findCsiFinalByteIndex('\x1b[38;2\x18A', 2)).toBe(5)
    expect(findCsiFinalByteIndex('\x1b[38;2\x1aA', 2)).toBe(5)
  })
})

describe('reply query extraction after an aborted CSI', () => {
  it('finds a CPR that follows a carried partial CSI', () => {
    const result = extractHiddenStartupRendererQueryData('\x1b[6n', '\x1b[38;2;177;1')

    expect(result.statefulQueryData).toBe('\x1b[6n')
    expect(result.pending).toBe('')
  })

  it('reports a CPR that follows a truncated CSI in the same chunk', () => {
    expect(containsStatefulRendererQuery('\x1b[38;2;1\x1b[6n')).toBe(true)
  })
})
