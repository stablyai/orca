import { describe, expect, it } from 'vitest'
import { terminalOutputPrefersDomRenderer } from './terminal-complex-script'

describe('terminalOutputPrefersDomRenderer', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputPrefersDomRenderer('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputPrefersDomRenderer('Hebrew: שלום')).toBe(true)
  })

  it('detects East Asian wide and fullwidth terminal output', () => {
    expect(
      terminalOutputPrefersDomRenderer('直接接请求本地 /api/mcp，带同一个 Bearer token，成功')
    ).toBe(true)
    expect(terminalOutputPrefersDomRenderer('Japanese: ターミナル')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('Korean: 터미널')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('Fullwidth: ＡＢＣ１２３')).toBe(true)
  })

  it('keeps terminal drawing glyphs on WebGL', () => {
    expect(terminalOutputPrefersDomRenderer('⠋ Working')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('├─ file.ts')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('█ progress')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('◆ status')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('\uE0B0 prompt')).toBe(false)
  })

  it('detects malformed replacement characters', () => {
    expect(terminalOutputPrefersDomRenderer('bad replacement �')).toBe(true)
  })

  it('detects emoji and variation sequences', () => {
    expect(terminalOutputPrefersDomRenderer('status 🚀')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('developer 👩‍💻')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('heart ♥️')).toBe(true)
  })

  it('detects supplementary-plane complex-script ranges', () => {
    expect(terminalOutputPrefersDomRenderer('Adlam: 𞤀')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('Medefaidrin: 𐻀')).toBe(true)
  })

  it('detects split surrogate chunks so fallback is not lost at chunk boundaries', () => {
    const [high, low] = Array.from('🚀')[0].split('')

    expect(terminalOutputPrefersDomRenderer(high)).toBe(true)
    expect(terminalOutputPrefersDomRenderer(low)).toBe(true)
  })

  it('detects ASCII ANSI background SGR output before the non-ASCII fast path', () => {
    expect(terminalOutputPrefersDomRenderer('\x1b[48;2;12;34;56m codex input \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('\x1b[48:2::12:34:56m codex input \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('\x1b[44m selected block \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('\x1b[104m bright selected block \x1b[0m')).toBe(true)
  })

  it('does not disable WebGL for ordinary terminal output or ANSI controls alone', () => {
    expect(terminalOutputPrefersDomRenderer('abc 123 ✓')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('\x1b[32mplain green\x1b[0m')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('\x1b[38;2;48;34;56m foreground only\x1b[0m')).toBe(
      false
    )
    expect(terminalOutputPrefersDomRenderer('\x1b[38:2::48:34:56m foreground only\x1b[0m')).toBe(
      false
    )
  })
})
