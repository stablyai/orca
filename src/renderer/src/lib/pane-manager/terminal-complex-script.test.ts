import { describe, expect, it } from 'vitest'
import { terminalOutputPrefersDomRenderer } from './terminal-complex-script'

describe('terminalOutputPrefersDomRenderer', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputPrefersDomRenderer('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputPrefersDomRenderer('Hebrew: שלום')).toBe(true)
  })

  it('detects glyph classes common in agent terminal UIs', () => {
    expect(terminalOutputPrefersDomRenderer('⠋ Working')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('├─ file.ts')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('█ progress')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('◆ status')).toBe(true)
    expect(terminalOutputPrefersDomRenderer('\uE0B0 prompt')).toBe(true)
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

  it('does not disable WebGL for ordinary terminal output or ANSI controls alone', () => {
    expect(terminalOutputPrefersDomRenderer('abc 123 ✓')).toBe(false)
    expect(terminalOutputPrefersDomRenderer('\x1b[32mplain green\x1b[0m')).toBe(false)
  })
})
