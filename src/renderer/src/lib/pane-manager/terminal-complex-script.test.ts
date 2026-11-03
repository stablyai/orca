import { describe, expect, it } from 'vitest'
import {
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision
} from './terminal-complex-script'

describe('terminalOutputPrefersRenderRefresh', () => {
  it('detects ASCII ANSI background SGR output before the non-ASCII fast path', () => {
    expect(terminalOutputPrefersRenderRefresh('\x1b[48;2;12;34;56m codex input \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[48:2::12:34:56m codex input \x1b[0m')).toBe(
      true
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[44m selected block \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[104m bright selected block \x1b[0m')).toBe(true)
  })

  it('does not disable WebGL for ordinary terminal output or ANSI controls alone', () => {
    expect(terminalOutputPrefersRenderRefresh('abc 123 ✓')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[38;2;48;34;56m foreground only\x1b[0m')).toBe(
      false
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[38:2::48:34:56m foreground only\x1b[0m')).toBe(
      false
    )
  })

  it('keeps the shared SGR scan stateless across calls', () => {
    // The global pattern can return mid-loop; reset lastIndex or the next call skips matches.
    expect(terminalOutputPrefersRenderRefresh('\x1b[41m selected \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[44m x\x1b[0m')).toBe(true)
  })
})

describe('terminalRewriteOutputRenderRefreshDecision', () => {
  it('refreshes when a trailing carriage return continues as a split redraw', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('• Working without erase-line', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('does not refresh split CRLF output', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('line one\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('\nline two', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })

  it('refreshes when a rewrite erase sequence is split across chunks', () => {
    const trailingRewriteCsi = terminalRewriteOutputRenderRefreshDecision('\r\x1b[', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingRewriteCsi).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: true
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2K• Working', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('carries rewrite erase sequence tails split before CSI introducer or params', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('\x1b', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2J', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('drops overlong rewrite CSI tails', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision(`\x1b[${'1'.repeat(80)}`, {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })
})
