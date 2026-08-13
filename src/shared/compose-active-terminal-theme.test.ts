import { describe, expect, it } from 'vitest'
import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from './types'
import {
  composeActiveTerminalTheme,
  composedTerminalThemesEqual,
  hexToRgba,
  isHexColor
} from './compose-active-terminal-theme'

describe('composeActiveTerminalTheme', () => {
  function settingsWith(partial: Partial<GlobalSettings>): GlobalSettings {
    return {
      terminalColorOverrides: undefined,
      terminalCursorOpacity: undefined,
      terminalBackgroundOpacity: undefined,
      ...partial
    } as GlobalSettings
  }

  it('layers terminal scrollbar defaults under the base theme', () => {
    const base = { background: '#101010', foreground: '#fafafa', cursor: '#fafafa' }
    const result = composeActiveTerminalTheme(base, settingsWith({}))
    expect(result).toEqual({
      overviewRulerBorder: 'transparent',
      scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
      scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
      scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
      ...base
    })
  })

  it('lets the base theme override terminal scrollbar defaults', () => {
    const result = composeActiveTerminalTheme(
      {
        background: '#101010',
        overviewRulerBorder: '#222222',
        scrollbarSliderBackground: 'rgba(1, 2, 3, 0.4)'
      },
      settingsWith({})
    )

    expect(result!.overviewRulerBorder).toBe('#222222')
    expect(result!.scrollbarSliderBackground).toBe('rgba(1, 2, 3, 0.4)')
  })

  it('layers terminalColorOverrides on top of the base theme', () => {
    const base = { background: '#101010', foreground: '#fafafa' }
    const result = composeActiveTerminalTheme(
      base,
      settingsWith({ terminalColorOverrides: { foreground: '#00ff00' } })
    )
    expect(result!.foreground).toBe('#00ff00')
    expect(result!.background).toBe('#101010')
  })

  it('applies background opacity by converting the hex background to rgba', () => {
    const base = { background: '#112233' }
    const result = composeActiveTerminalTheme(
      base,
      settingsWith({ terminalBackgroundOpacity: 0.5 })
    )
    expect(result!.background).toBe('rgba(17, 34, 51, 0.5)')
  })

  it('honors a zero background opacity', () => {
    const base = { background: '#112233' }
    const result = composeActiveTerminalTheme(base, settingsWith({ terminalBackgroundOpacity: 0 }))
    expect(result!.background).toBe('rgba(17, 34, 51, 0)')
  })

  it('applies cursor opacity only when the cursor is a hex color', () => {
    const base = { cursor: '#ffffff' }
    const result = composeActiveTerminalTheme(base, settingsWith({ terminalCursorOpacity: 0.3 }))
    expect(result!.cursor).toBe('rgba(255, 255, 255, 0.3)')
  })

  it('leaves named CSS cursor colors untouched when applying opacity', () => {
    const base = { cursor: 'red' }
    const result = composeActiveTerminalTheme(base, settingsWith({ terminalCursorOpacity: 0.3 }))
    expect(result!.cursor).toBe('red')
  })

  it('returns null when given a null base theme', () => {
    expect(composeActiveTerminalTheme(null, settingsWith({}))).toBeNull()
  })

  it('applies the single terminalColorOverrides map onto a light base theme (#10581 checkpoint)', () => {
    // Why: today terminalColorOverrides is one map, not per-mode. Composing a
    // light base still receives those overrides (current behavior). If #10581
    // lands per-mode maps, this test must switch to "dark-only overrides do
    // not enter light snapshots" and every caller must pass slot.
    const result = composeActiveTerminalTheme(
      { background: '#fafafa', foreground: '#111111' },
      settingsWith({
        terminalColorOverrides: { foreground: '#00ff00', background: '#000000' }
      })
    )
    expect(result!.foreground).toBe('#00ff00')
    expect(result!.background).toBe('#000000')
  })
})

describe('hexToRgba', () => {
  it('converts 6-char hex to rgba', () => {
    expect(hexToRgba('#1a1a1a', 0.72)).toBe('rgba(26, 26, 26, 0.72)')
  })

  it('converts 3-char shorthand hex to rgba', () => {
    expect(hexToRgba('#f0f', 0.5)).toBe('rgba(255, 0, 255, 0.5)')
  })
})

describe('isHexColor', () => {
  it('accepts hex colors with or without a leading hash', () => {
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('112233')).toBe(true)
    expect(isHexColor('red')).toBe(false)
  })
})

describe('composedTerminalThemesEqual', () => {
  const base: ITheme = { background: '#111111', foreground: '#eeeeee' }

  it('returns false when the previous theme is missing', () => {
    expect(composedTerminalThemesEqual(undefined, base)).toBe(false)
  })

  it('returns true for identical composed palettes', () => {
    expect(composedTerminalThemesEqual({ ...base }, { ...base })).toBe(true)
  })

  it('returns false when a color slot differs', () => {
    expect(composedTerminalThemesEqual(base, { ...base, background: '#000000' })).toBe(false)
  })

  it('compares extendedAnsi by value', () => {
    expect(
      composedTerminalThemesEqual(
        { ...base, extendedAnsi: ['#111', '#222'] },
        { ...base, extendedAnsi: ['#111', '#222'] }
      )
    ).toBe(true)
    expect(
      composedTerminalThemesEqual(
        { ...base, extendedAnsi: ['#111'] },
        { ...base, extendedAnsi: ['#222'] }
      )
    ).toBe(false)
  })
})
