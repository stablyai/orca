import { describe, expect, it } from 'vitest'
import { buildFontFamily } from '../../../../shared/styles/monospace-font-family'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

describe('buildDefaultTerminalOptions', () => {
  it('starts from the same font chain the settings-driven path builds', () => {
    const { fontFamily } = buildDefaultTerminalOptions()
    expect(fontFamily).toBe(buildFontFamily(''))
    expect(fontFamily).toContain('"Orca Nerd Font Symbols"')
  })

  it('rescales one-cell glyphs that a fallback face draws wider than a cell', () => {
    expect(buildDefaultTerminalOptions().rescaleOverlappingGlyphs).toBe(true)
  })
})
