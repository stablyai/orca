import { describe, expect, it } from 'vitest'
import {
  terminalOutputContainsEastAsianRendererRisk,
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh
} from './terminal-complex-script'

describe('terminalOutputPrefersRenderRefresh', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputPrefersRenderRefresh('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputPrefersRenderRefresh('Hebrew: שלום')).toBe(true)
  })

  it('detects East Asian wide and fullwidth terminal output', () => {
    expect(
      terminalOutputPrefersRenderRefresh('直接接请求本地 /api/mcp，带同一个 Bearer token，成功')
    ).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Japanese: ターミナル')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Korean: 터미널')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Fullwidth: ＡＢＣ１２３')).toBe(true)
  })

  it('keeps terminal drawing glyphs on WebGL', () => {
    expect(terminalOutputPrefersRenderRefresh('⠋ Working')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('├─ file.ts')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('█ progress')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('◆ status')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\uE0B0 prompt')).toBe(false)
  })

  it('detects malformed replacement characters', () => {
    expect(terminalOutputPrefersRenderRefresh('bad replacement �')).toBe(true)
  })

  it('detects emoji and variation sequences', () => {
    expect(terminalOutputPrefersRenderRefresh('status 🚀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('developer 👩‍💻')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('heart ♥️')).toBe(true)
  })

  it('detects supplementary-plane complex-script ranges', () => {
    expect(terminalOutputPrefersRenderRefresh('Adlam: 𞤀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Medefaidrin: 𐻀')).toBe(true)
  })

  it('detects split surrogate chunks so refresh is not lost at chunk boundaries', () => {
    const [high, low] = Array.from('🚀')[0].split('')

    expect(terminalOutputPrefersRenderRefresh(high)).toBe(true)
    expect(terminalOutputPrefersRenderRefresh(low)).toBe(true)
  })

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
})

describe('terminalOutputContainsEastAsianRendererRisk', () => {
  it('detects CJK, fullwidth, and Korean output', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('已经安装完成，软件已更新后重启。')).toBe(
      true
    )
    expect(terminalOutputContainsEastAsianRendererRisk('Fullwidth: ＡＢＣ１２３')).toBe(true)
    expect(terminalOutputContainsEastAsianRendererRisk('Korean: 터미널')).toBe(true)
  })

  it('does not match non-East-Asian renderer-risk Unicode', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('Arabic: السلام عليكم')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('status 🚀')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('developer 👩‍💻')).toBe(false)
  })
})

describe('terminalRewriteOutputPrefersRenderRefresh', () => {
  it('detects in-place carriage-return redraws', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('prefix\r\x1b[2K• Working')).toBe(true)
  })

  it('does not treat normal CRLF output as an in-place redraw', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r\nline two\r\n')).toBe(false)
  })

  it('waits on a trailing carriage return so split CRLF output does not refresh early', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\nline two')).toBe(false)
  })

  it('detects terminal erase rewrites and backspace updates', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2J\x1b[Hredraw')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('progress 10%\b\b20%')).toBe(true)
  })

  it('still detects split Codex-style rewrites through the erase-line chunk', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
  })

  it('ignores ordinary cursor movement and style output', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[10;2Hcursor move')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
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

  it('preserves pending trailing carriage return state across empty chunks', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: false
    })
  })
})
