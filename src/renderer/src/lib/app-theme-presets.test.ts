import { describe, expect, it } from 'vitest'
import {
  APP_THEME_PRESETS,
  getMatchingTerminalTheme,
  resolveEffectiveThemePreset
} from './app-theme-presets'

describe('app-theme-presets', () => {
  it('registers all planned themes with valid swatches and modes', () => {
    expect(APP_THEME_PRESETS.length).toBeGreaterThanOrEqual(10)
    for (const preset of APP_THEME_PRESETS) {
      expect(preset.id).toBeTruthy()
      expect(preset.name).toBeTruthy()
      expect(['dark', 'light']).toContain(preset.mode)
      expect(preset.swatches.background).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(preset.swatches.card).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(preset.swatches.primary).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(preset.swatches.accent).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('resolves default preset when undefined or default is passed', () => {
    expect(resolveEffectiveThemePreset('dark', undefined, true)).toBe('default')
    expect(resolveEffectiveThemePreset('light', 'default', false)).toBe('default')
    expect(resolveEffectiveThemePreset('system', 'default', true)).toBe('default')
  })

  it('preserves matching mode presets directly', () => {
    expect(resolveEffectiveThemePreset('dark', 'dracula', true)).toBe('dracula')
    expect(resolveEffectiveThemePreset('dark', 'nord', false)).toBe('nord')
    expect(resolveEffectiveThemePreset('dark', 'material-dark', true)).toBe('material-dark')
    expect(resolveEffectiveThemePreset('light', 'catppuccin-latte', false)).toBe('catppuccin-latte')
    expect(resolveEffectiveThemePreset('light', 'solarized-light', true)).toBe('solarized-light')
    expect(resolveEffectiveThemePreset('light', 'material-light', false)).toBe('material-light')
  })

  it('swaps to complementary counterpart when effective mode flips', () => {
    // Catppuccin Mocha is dark; when in light mode, should swap to Catppuccin Latte
    expect(resolveEffectiveThemePreset('light', 'catppuccin-mocha', false)).toBe('catppuccin-latte')
    // Catppuccin Latte is light; when in dark mode, should swap to Catppuccin Mocha
    expect(resolveEffectiveThemePreset('dark', 'catppuccin-latte', true)).toBe('catppuccin-mocha')
    // Solarized Dark in light mode -> Solarized Light
    expect(resolveEffectiveThemePreset('light', 'solarized-dark', false)).toBe('solarized-light')
    // Solarized Light in dark mode -> Solarized Dark
    expect(resolveEffectiveThemePreset('dark', 'solarized-light', true)).toBe('solarized-dark')
    // GitHub Dark in light mode -> GitHub Light
    expect(resolveEffectiveThemePreset('light', 'github-dark', false)).toBe('github-light')
    // Material 3 Dark in light mode -> Material 3 Light
    expect(resolveEffectiveThemePreset('light', 'material-dark', false)).toBe('material-light')
    // Material 3 Light in dark mode -> Material 3 Dark
    expect(resolveEffectiveThemePreset('dark', 'material-light', true)).toBe('material-dark')
    // iOS 27 Liquid Glass Dark in light mode -> Liquid Glass Light
    expect(resolveEffectiveThemePreset('light', 'liquid-glass-dark', false)).toBe(
      'liquid-glass-light'
    )
    // iOS 27 Liquid Glass Light in dark mode -> Liquid Glass Dark
    expect(resolveEffectiveThemePreset('dark', 'liquid-glass-light', true)).toBe(
      'liquid-glass-dark'
    )
    // Dala Dark in light mode -> Dala Light
    expect(resolveEffectiveThemePreset('light', 'dala-dark', false)).toBe('dala-light')
    expect(resolveEffectiveThemePreset('dark', 'dala-light', true)).toBe('dala-dark')
    // Discord Dark in light mode -> Discord Light
    expect(resolveEffectiveThemePreset('light', 'discord-dark', false)).toBe('discord-light')
    expect(resolveEffectiveThemePreset('dark', 'discord-light', true)).toBe('discord-dark')
    // Dope Security Dark in light mode -> Dope Security Light
    expect(resolveEffectiveThemePreset('light', 'dope-security-dark', false)).toBe(
      'dope-security-light'
    )
    expect(resolveEffectiveThemePreset('dark', 'dope-security-light', true)).toBe(
      'dope-security-dark'
    )
    // Raycast Dark in light mode -> Raycast Light
    expect(resolveEffectiveThemePreset('light', 'raycast-dark', false)).toBe('raycast-light')
    expect(resolveEffectiveThemePreset('dark', 'raycast-light', true)).toBe('raycast-dark')
    // zkPass Dark in light mode -> zkPass Light
    expect(resolveEffectiveThemePreset('light', 'zkpass-dark', false)).toBe('zkpass-light')
    expect(resolveEffectiveThemePreset('dark', 'zkpass-light', true)).toBe('zkpass-dark')
    // Miranda Light in dark mode -> Miranda Dark
    expect(resolveEffectiveThemePreset('dark', 'miranda-light', true)).toBe('miranda-dark')
    expect(resolveEffectiveThemePreset('light', 'miranda-dark', false)).toBe('miranda-light')
  })

  it('falls back to default for dark-only presets in light mode', () => {
    expect(resolveEffectiveThemePreset('light', 'dracula', false)).toBe('default')
    expect(resolveEffectiveThemePreset('light', 'nord', false)).toBe('default')
    expect(resolveEffectiveThemePreset('light', 'tokyo-night', false)).toBe('default')
  })
  it('finds matching terminal theme for preset', () => {
    expect(getMatchingTerminalTheme('default', 'light')).toBe('Builtin Tango Light')
    expect(getMatchingTerminalTheme('default', 'dark')).toBe('Ghostty Default Style Dark')
    expect(getMatchingTerminalTheme('dracula')).toBe('Dracula')
    expect(getMatchingTerminalTheme('nord')).toBe('Nord')
    expect(getMatchingTerminalTheme('tokyo-night')).toBe('Tokyo Night')
    expect(getMatchingTerminalTheme('catppuccin-mocha')).toBe('Catppuccin Mocha')
    expect(getMatchingTerminalTheme('catppuccin-latte')).toBe('Catppuccin Latte')
    expect(getMatchingTerminalTheme('solarized-dark')).toBe('Solarized Dark')
    expect(getMatchingTerminalTheme('solarized-light')).toBe('Solarized Light')
    expect(getMatchingTerminalTheme('github-dark')).toBe('GitHub Dark')
    expect(getMatchingTerminalTheme('github-light')).toBe('GitHub Light')
    expect(getMatchingTerminalTheme('material-dark')).toBe('Material 3 Dark')
    expect(getMatchingTerminalTheme('material-light')).toBe('Material 3 Light')
    expect(getMatchingTerminalTheme('liquid-glass-dark')).toBe('iOS 27 Liquid Glass Dark')
    expect(getMatchingTerminalTheme('liquid-glass-light')).toBe('iOS 27 Liquid Glass Light')
    expect(getMatchingTerminalTheme('dala-dark')).toBe('Dala Dark')
    expect(getMatchingTerminalTheme('dala-light')).toBe('Dala Light')
    expect(getMatchingTerminalTheme('discord-dark')).toBe('Discord Dark')
    expect(getMatchingTerminalTheme('discord-light')).toBe('Discord Light')
    expect(getMatchingTerminalTheme('dope-security-dark')).toBe('Dope Security Dark')
    expect(getMatchingTerminalTheme('dope-security-light')).toBe('Dope Security Light')
    expect(getMatchingTerminalTheme('raycast-dark')).toBe('Raycast Dark')
    expect(getMatchingTerminalTheme('raycast-light')).toBe('Raycast Light')
    expect(getMatchingTerminalTheme('zkpass-dark')).toBe('zkPass Dark')
    expect(getMatchingTerminalTheme('zkpass-light')).toBe('zkPass Light')
    expect(getMatchingTerminalTheme('miranda-light')).toBe('Miranda Paper')
    expect(getMatchingTerminalTheme('miranda-dark')).toBe('Miranda Ink')
  })
})
