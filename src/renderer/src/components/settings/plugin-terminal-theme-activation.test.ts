import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  activeTerminalThemeSelection,
  terminalThemeActivationUpdate
} from './plugin-terminal-theme-activation'

const THEME_ID = 'plugin:stablyai.orca-solarized-terminal/solarized-dark' as const

describe('plugin terminal theme activation', () => {
  it('applies to the active dark slot', () => {
    const settings = { ...getDefaultSettings('/tmp'), theme: 'dark' as const }

    expect(terminalThemeActivationUpdate(settings, THEME_ID, false)).toEqual({
      terminalThemeDark: THEME_ID
    })
  })

  it('applies to a separately configured active light slot', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'system' as const,
      terminalUseSeparateLightTheme: true
    }

    expect(terminalThemeActivationUpdate(settings, THEME_ID, false)).toEqual({
      terminalThemeLight: THEME_ID
    })
    expect(activeTerminalThemeSelection({ ...settings, terminalThemeLight: THEME_ID }, false)).toBe(
      THEME_ID
    )
  })

  it('uses the dark slot when light mode shares its terminal theme', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'light' as const,
      terminalUseSeparateLightTheme: false
    }

    expect(terminalThemeActivationUpdate(settings, THEME_ID, false)).toEqual({
      terminalThemeDark: THEME_ID
    })
  })
})
