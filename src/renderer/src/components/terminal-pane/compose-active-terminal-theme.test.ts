import { describe, expect, it } from 'vitest'
import { composeActiveTerminalTheme } from './terminal-appearance'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

describe('composeActiveTerminalTheme', () => {
  function settingsWith(partial: Partial<GlobalSettings>): GlobalSettings {
    return {
      terminalCursorOpacity: undefined,
      terminalBackgroundOpacity: undefined,
      ...partial
    } as GlobalSettings
  }

  it('layers foreground-tinted scrollbar defaults under the base theme', () => {
    // A light terminal's dark foreground keeps the thumb visible where a fixed light grey vanished (#12635).
    const base = { background: '#ffffff', foreground: '#2e3434', cursor: '#2e3434' }
    const result = composeActiveTerminalTheme(base, settingsWith({}))
    expect(result).toEqual({
      overviewRulerBorder: 'transparent',
      scrollbarSliderBackground: 'rgba(46, 52, 52, 0.35)',
      scrollbarSliderHoverBackground: 'rgba(46, 52, 52, 0.55)',
      scrollbarSliderActiveBackground: 'rgba(46, 52, 52, 0.7)',
      ...base
    })
  })

  it('raises the thumb alpha on a muted dark theme to match the legacy grey contrast', () => {
    const base = { background: '#002b36', foreground: '#839496' }
    const result = composeActiveTerminalTheme(base, settingsWith({}))
    expect(result).toMatchObject({
      scrollbarSliderBackground: 'rgba(131, 148, 150, 0.53)',
      scrollbarSliderHoverBackground: 'rgba(131, 148, 150, 0.8)',
      scrollbarSliderActiveBackground: 'rgba(131, 148, 150, 1)'
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

  it('applies background opacity by converting the hex background to rgba', () => {
    const base = { background: '#112233' }
    const result = composeActiveTerminalTheme(
      base,
      settingsWith({ terminalBackgroundOpacity: 0.5 })
    )
    expect(result!.background).toBe('rgba(17, 34, 51, 0.5)')
  })

  it('honors a zero background opacity', () => {
    // Opacity zero means intentional full transparency; truthiness guards would discard it.
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
})
