import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { activateOrcaTerminalUnicodeProvider } from './terminal-unicode-provider'

// Why: xterm's public IUnicodeHandling exposes only register/activeVersion, but
// the buffer layout (charProperties) and width-measuring paths run through the
// internal UnicodeService. Exercising it is what actually proves cell widths.
type UnicodeService = {
  wcwidth(codepoint: number): 0 | 1 | 2
  getStringCellWidth(text: string): number
}

function makeUnicodeService(): UnicodeService {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal as never)
  return (terminal as unknown as { _core: { unicodeService: UnicodeService } })._core.unicodeService
}

describe('OrcaUnicodeProvider enclosed-ambiguous width', () => {
  it('budgets enclosed alphanumerics as two cells so their full-width glyph fits', () => {
    const svc = makeUnicodeService()
    expect(svc.wcwidth(0x2460)).toBe(2) // ①
    expect(svc.wcwidth(0x2473)).toBe(2) // ⑳
    expect(svc.wcwidth(0x24e9)).toBe(2) // ⓩ (end of the first ambiguous run)
    expect(svc.wcwidth(0x24ff)).toBe(2) // ◿ block end (ambiguous)
    expect(svc.wcwidth(0x1f130)).toBe(2) // 🄰 Enclosed Alphanumeric Supplement
  })

  it('measures a circled number before ASCII as 2+1 cells (the overlap case)', () => {
    const svc = makeUnicodeService()
    expect(svc.getStringCellWidth('①')).toBe(2)
    // ① takes two cells, so the trailing "A" lands past it instead of overlapping.
    expect(svc.getStringCellWidth('①A')).toBe(3)
  })

  it('widens an astral enclosed glyph through the layout (charProperties) path', () => {
    const svc = makeUnicodeService()
    // 🄰 U+1F130 is astral (surrogate pair), decoded before the width lookup.
    expect(svc.getStringCellWidth('\u{1F130}')).toBe(2)
    expect(svc.getStringCellWidth('\u{1F130}A')).toBe(3)
  })

  it('keeps a combining mark after a widened glyph at zero added width', () => {
    const svc = makeUnicodeService()
    // ① (U+2460) widened to 2 cells; the combining grave (U+0300) inherits and
    // contributes 0, so the total stays 2 (and 3 with a trailing ASCII). Built
    // from char codes because a literal combining mark is invisible in source.
    const circledWithGrave = String.fromCharCode(0x2460, 0x0300)
    expect(svc.getStringCellWidth(circledWithGrave)).toBe(2)
    expect(svc.getStringCellWidth(`${circledWithGrave}A`)).toBe(3)
  })

  it('leaves non-ambiguous and ASCII code points unchanged', () => {
    const svc = makeUnicodeService()
    expect(svc.wcwidth(0x3251)).toBe(2) // ㉑ already wide (EAW=Wide) in unicode11
    expect(svc.wcwidth(0x3231)).toBe(2) // ㈱ already wide
    // ⓪ is EAW=Neutral (not Ambiguous), so Unicode calls it narrow — not widened.
    expect(svc.wcwidth(0x24ea)).toBe(1) // ⓪
    expect(svc.wcwidth(0x41)).toBe(1) // A
    expect(svc.getStringCellWidth('AB')).toBe(2)
  })

  it('still joins ZWJ emoji into one wide pair', () => {
    const svc = makeUnicodeService()
    expect(svc.getStringCellWidth('\u{1F469}\u{200D}\u{1F4BB}')).toBe(2) // 👩‍💻
  })
})
