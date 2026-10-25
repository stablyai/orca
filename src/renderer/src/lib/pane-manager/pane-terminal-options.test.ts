import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: (): NodeJS.Platform => 'win32'
}))

describe('buildDefaultTerminalOptions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts from the full font chain, including the bundled symbols and CJK faces', () => {
    vi.stubGlobal('navigator', { languages: ['ko-KR'], language: 'ko-KR' })
    expect(buildDefaultTerminalOptions().fontFamily).toBe(
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", "Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Meiryo", "Microsoft JhengHei", monospace'
    )
  })

  it('rescales one-cell glyphs that a fallback face draws wider than a cell', () => {
    expect(buildDefaultTerminalOptions().rescaleOverlappingGlyphs).toBe(true)
  })
})
