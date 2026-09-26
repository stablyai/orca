import { describe, expect, it } from 'vitest'
import { buildFontFamily } from './monospace-font-family'

const FULL_FALLBACK =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('puts custom font first with full cross-platform fallback chain', () => {
    const result = buildFontFamily('JetBrains Mono')
    expect(result).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('places custom fallbacks between the primary font and Orca defaults', () => {
    const result = buildFontFamily('MesloLGS NF', ['Microsoft YaHei UI', 'Noto Sans Arabic'])
    expect(result).toBe(`"MesloLGS NF", "Microsoft YaHei UI", "Noto Sans Arabic", ${FULL_FALLBACK}`)
  })

  it('ignores empty and duplicate custom fallbacks', () => {
    const result = buildFontFamily('SF Mono', [' ', 'Noto Sans', 'noto sans', 'SF Mono'])
    expect(result).toBe(
      '"SF Mono", "Noto Sans", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate SF Mono when it is the input', () => {
    const result = buildFontFamily('SF Mono')
    expect(result).toBe(
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('returns full fallback chain for empty string', () => {
    const result = buildFontFamily('')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    const result = buildFontFamily('   ')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('keeps distinct family names that contain an Orca default name', () => {
    const result = buildFontFamily('My SF Mono Custom', ['Menlo Extra', 'monospace'])
    expect(result).toBe(
      '"My SF Mono Custom", "Menlo Extra", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    const result = buildFontFamily('Consolas')
    expect(result).toBe(
      '"Consolas", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate MesloLGS Nerd Font when it is the input', () => {
    const result = buildFontFamily('MesloLGS Nerd Font')
    expect(result).toBe(
      '"MesloLGS Nerd Font", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate the bundled Nerd Font symbol fallback', () => {
    const result = buildFontFamily('Orca Nerd Font Symbols')
    expect(result).toBe(
      '"Orca Nerd Font Symbols", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })
})
