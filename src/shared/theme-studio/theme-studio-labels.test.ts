import { describe, expect, it } from 'vitest'
import { themeStudioAdjustLabel, themeStudioSetLabel } from './theme-studio-labels'

describe('theme studio labels', () => {
  it('describes an adjustment in plain words', () => {
    expect(themeStudioAdjustLabel({ warmth: 20, contrast: 10 })).toBe('Warmer, more contrast')
    expect(themeStudioAdjustLabel({ hue: 20 })).toBe('Hues shifted 20°')
    expect(themeStudioAdjustLabel({}, { scope: 'sidebar', amount: 0.04 })).toBe(
      'Sidebars set apart'
    )
  })

  it('names one or two colors and counts more', () => {
    expect(themeStudioSetLabel(['--worktree-sidebar=#222'])).toBe(
      'Changed the worktree sidebar color'
    )
    expect(themeStudioSetLabel(['--tab-bar=#111', 'terminal.red=#f00'])).toBe(
      'Changed the tab bar and terminal red colors'
    )
    expect(themeStudioSetLabel(['--a=#1', '--b=#2', '--c=#3'])).toBe('Changed 3 colors')
  })
})
