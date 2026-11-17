import { describe, expect, it } from 'vitest'
import { buildFontFamily } from './monospace-font-family'

const FULL_CHAIN =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('keeps a single family identical to before', () => {
    expect(buildFontFamily('JetBrains Mono')).toBe(`"JetBrains Mono", ${FULL_CHAIN}`)
  })

  it('splits a comma-separated stack into individually quoted families', () => {
    const result = buildFontFamily('JetBrains Mono, Menk Qagan StdEx Tig')
    expect(result.startsWith('"JetBrains Mono", "Menk Qagan StdEx Tig", "SF Mono"')).toBe(true)
  })

  it('strips surrounding quotes from entered families and keeps inners intact', () => {
    const result = buildFontFamily('"JetBrains Mono", \'Menk Qagan StdEx Tig\'')
    expect(result.startsWith('"JetBrains Mono", "Menk Qagan StdEx Tig", "SF Mono"')).toBe(true)
  })

  it('treats a comma inside quotes as part of the family name', () => {
    const result = buildFontFamily('"My, Font"')
    expect(result.startsWith('"My, Font", "SF Mono"')).toBe(true)
  })

  it('drops empty entries and trailing separators', () => {
    const result = buildFontFamily('JetBrains Mono, , Menlo,, ')
    expect(result.startsWith('"JetBrains Mono", "Menlo", "SF Mono", "Monaco"')).toBe(true)
  })

  it('an empty setting still yields only the fallback chain', () => {
    expect(buildFontFamily('   ')).toBe(FULL_CHAIN)
  })

  it('a stack entry suppresses its own duplicate from the fallback chain', () => {
    const result = buildFontFamily('Menk Qagan StdEx Tig, Menlo')
    expect(result.startsWith('"Menk Qagan StdEx Tig", "Menlo", "SF Mono"')).toBe(true)
    // Menlo came from the user, so the chain must not repeat it after Monaco.
    expect(result).not.toMatch(/"Menlo".*"Menlo"/)
  })

  it('a plugin family is never split and keeps the whole chain', () => {
    const result = buildFontFamily('Menlo (acme.fonts)')
    expect(result.startsWith('"Menlo (acme.fonts)", "SF Mono"')).toBe(true)
    expect(result.endsWith('monospace')).toBe(true)
  })
})
