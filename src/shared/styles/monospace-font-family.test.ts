import { describe, expect, it } from 'vitest'
import { buildFontFamily } from './monospace-font-family'

const FALLBACKS =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('quotes a single family ahead of the fallbacks, leaving out the one it names', () => {
    expect(buildFontFamily('JetBrains Mono')).toBe(`"JetBrains Mono", ${FALLBACKS}`)
    expect(buildFontFamily('menlo')).toBe(`"menlo", ${FALLBACKS.replace('"Menlo", ', '')}`)
    expect(buildFontFamily('  ')).toBe(FALLBACKS)
  })

  it('keeps every fallback for a plugin family', () => {
    expect(buildFontFamily('Menlo (acme.fonts)')).toBe(`"Menlo (acme.fonts)", ${FALLBACKS}`)
  })

  it('quotes each family of a list and lists a fallback only once', () => {
    expect(buildFontFamily('D2Coding, Consolas')).toBe(
      `"D2Coding", "Consolas", ${FALLBACKS.replace('"Consolas", ', '')}`
    )
  })

  it('leaves a listed generic or vendor keyword bare', () => {
    const chainWithoutMonospace = FALLBACKS.replace(', monospace', '')
    expect(buildFontFamily('Menlo, monospace')).toBe(
      `"Menlo", monospace, ${chainWithoutMonospace.replace('"Menlo", ', '')}`
    )
    expect(buildFontFamily('ui-monospace, Menlo')).toBe(
      `ui-monospace, "Menlo", ${FALLBACKS.replace('"Menlo", ', '')}`
    )
    expect(buildFontFamily(`"Cascadia Mono", 'D2Coding' ,, monospace`)).toBe(
      `"Cascadia Mono", "D2Coding", monospace, ${chainWithoutMonospace.replace('"Cascadia Mono", ', '')}`
    )
  })

  it('quotes a single keyword as typed, like any single family', () => {
    const chainWithoutMonospace = FALLBACKS.replace(', monospace', '')
    expect(buildFontFamily('monospace')).toBe(`"monospace", ${chainWithoutMonospace}`)
    expect(buildFontFamily('ui-monospace')).toBe(`"ui-monospace", ${chainWithoutMonospace}`)
  })

  it('strips a stray quote left at either end of an entry', () => {
    expect(buildFontFamily(`D2Coding", "Consolas`)).toBe(
      `"D2Coding", "Consolas", ${FALLBACKS.replace('"Consolas", ', '')}`
    )
  })
})
