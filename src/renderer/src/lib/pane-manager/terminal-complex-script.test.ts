import { describe, expect, it } from 'vitest'
import { terminalOutputPrefersRenderRefresh } from './terminal-complex-script'

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
