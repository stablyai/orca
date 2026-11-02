import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { contrastRatio, safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'
import { resolvePaintedDark, synthesizeTerminalAppTheme } from './terminal-app-theme'

// Parses #rrggbb and rgb(r g b), which is all the synthesized theme and its inputs use.
const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (hex) {
    const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
    return [channel(0), channel(2), channel(4), 1]
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(value.trim())
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 1] : null
}

function settingsWith(overrides: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), theme: 'dark', ...overrides }
}

describe('synthesizeTerminalAppTheme', () => {
  it('keeps a low-contrast palette legible so the contrast gate drops nothing', () => {
    const settings = settingsWith({ terminalThemeDark: 'Solarized Light' })
    const theme = synthesizeTerminalAppTheme(settings, true, probe)
    expect(theme?.base).toBe('light')
    expect(theme?.tokens['--background']).toBe('#fdf6e3')
    expect(theme?.tokens['--sidebar']).toBe('#fdf6e3')
    const tokens = theme?.tokens ?? {}
    const color = (token: string) => probe(tokens[token] ?? '') ?? [0, 0, 0, 1]
    // Solarized's own #657b83 is 4.1:1 on its background; the theme darkens it just enough.
    expect(contrastRatio(color('--foreground'), color('--background'))).toBeGreaterThanOrEqual(4.5)
    expect(tokens['--foreground']).not.toBe('#000000')
    expect(Object.keys(safePluginThemeTokens(tokens, 'light', {}, probe))).toEqual(
      Object.keys(tokens)
    )
  })

  it('keeps a mid-tone background legible by tinting surfaces away from the text', () => {
    const settings = settingsWith({
      terminalColorOverrides: { background: '#757575', foreground: '#ffffff' }
    })
    const theme = synthesizeTerminalAppTheme(settings, true, probe)
    const tokens = theme?.tokens ?? {}
    expect(tokens['--background']).toBe('#757575')
    expect(Object.keys(safePluginThemeTokens(tokens, theme?.base ?? 'dark', {}, probe))).toEqual(
      Object.keys(tokens)
    )
  })

  it("follows the painting mode's color overrides and paints the background opaque", () => {
    const settings = settingsWith({
      terminalColorOverrides: { background: '#101820', foreground: '#f0f4f8' },
      terminalColorOverridesLight: { background: '#f8f4f0', foreground: '#201810' },
      terminalUseSeparateLightTheme: true,
      terminalBackgroundOpacity: 0.5
    })
    const dark = synthesizeTerminalAppTheme(settings, true, probe)
    expect(dark?.tokens).toMatchObject({ '--background': '#101820', '--foreground': '#f0f4f8' })
    const light = synthesizeTerminalAppTheme({ ...settings, theme: 'light' }, true, probe)
    expect(light?.base).toBe('light')
    expect(light?.tokens).toMatchObject({ '--background': '#f8f4f0', '--foreground': '#201810' })
  })
})

describe('resolvePaintedDark', () => {
  it('paints the mode of the terminal theme only when the slot matches the terminal', () => {
    const lightTerminal = settingsWith({
      terminalThemeDark: 'Solarized Light',
      pluginAppThemeDark: 'match-terminal'
    })
    expect(resolvePaintedDark(lightTerminal, true, true)).toBe(false)
    expect(resolvePaintedDark({ ...lightTerminal, pluginAppThemeDark: null }, true, true)).toBe(
      true
    )
  })
})
