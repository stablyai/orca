import { describe, expect, it } from 'vitest'
import {
  SCRYER_THEME_COLOR_ROLES,
  SCRYER_TAILWIND_PALETTES,
  createScryerThemeStyle,
  normalizeScryerTheme
} from './theme'

describe('Scryer theme settings', () => {
  it('exposes Scryer color roles and Tailwind palettes', () => {
    expect(SCRYER_THEME_COLOR_ROLES).toHaveLength(11)
    expect(SCRYER_TAILWIND_PALETTES).toHaveLength(22)
    expect(SCRYER_THEME_COLOR_ROLES.map((role) => role.id)).toContain('nodeFill')
    expect(SCRYER_TAILWIND_PALETTES.map((palette) => palette.id)).toContain('emerald')
  })

  it('normalizes partial settings and produces architecture CSS variables', () => {
    const theme = normalizeScryerTheme({
      mode: 'dark',
      paletteByRole: { canvas: 'slate', nodeFill: 'emerald' },
      lightOffset: 2,
      darkOffset: -1,
      canvasBackground: '#102030',
      nodeFill: '#203040'
    })

    expect(theme.paletteByRole.canvas).toBe('slate')
    expect(theme.paletteByRole.nodeFill).toBe('emerald')

    const style = createScryerThemeStyle(theme, true)
    expect(style['--architecture-canvas-bg']).toBe('#102030')
    expect(style['--architecture-node-fill']).toBe('#203040')
    expect(style['--architecture-role-primary']).toMatch(/^#/)
  })
})
