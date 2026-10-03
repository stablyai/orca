import { describe, expect, it, vi } from 'vitest'
import {
  ALL_EDITOR_THEMES,
  DARK_EDITOR_THEMES,
  DEFAULT_EDITOR_THEME_DARK,
  DEFAULT_EDITOR_THEME_LIGHT,
  LIGHT_EDITOR_THEMES,
  isKnownEditorTheme,
  registerMonacoThemes,
  resolveEditorTheme,
  type MonacoThemeRegistry
} from './monaco-themes'

describe('monaco-themes', () => {
  it('contains expected default themes and popular presets', () => {
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'vs-dark')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'dracula')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'one-dark-pro')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'github-dark')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'catppuccin-mocha')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'tokyo-night')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'nord')).toBe(true)
    expect(DARK_EDITOR_THEMES.some((t) => t.id === 'solarized-dark')).toBe(true)

    expect(LIGHT_EDITOR_THEMES.some((t) => t.id === 'vs')).toBe(true)
    expect(LIGHT_EDITOR_THEMES.some((t) => t.id === 'github-light')).toBe(true)
    expect(LIGHT_EDITOR_THEMES.some((t) => t.id === 'one-light')).toBe(true)
    expect(LIGHT_EDITOR_THEMES.some((t) => t.id === 'catppuccin-latte')).toBe(true)
    expect(LIGHT_EDITOR_THEMES.some((t) => t.id === 'solarized-light')).toBe(true)

    expect(ALL_EDITOR_THEMES.length).toBe(DARK_EDITOR_THEMES.length + LIGHT_EDITOR_THEMES.length)
  })

  it('validates known themes by mode', () => {
    expect(isKnownEditorTheme('dracula', 'dark')).toBe(true)
    expect(isKnownEditorTheme('dracula', 'light')).toBe(false)
    expect(isKnownEditorTheme('github-light', 'light')).toBe(true)
    expect(isKnownEditorTheme('github-light', 'dark')).toBe(false)
    expect(isKnownEditorTheme('non-existent')).toBe(false)
  })

  it('registers custom themes into monaco', () => {
    const defineTheme = vi.fn()
    const mockMonaco: MonacoThemeRegistry = {
      editor: { defineTheme }
    }

    registerMonacoThemes(mockMonaco)

    // Should define themes that have custom data
    expect(defineTheme).toHaveBeenCalledWith('dracula', expect.any(Object))
    expect(defineTheme).toHaveBeenCalledWith('one-dark-pro', expect.any(Object))
    expect(defineTheme).toHaveBeenCalledWith('github-dark', expect.any(Object))
    expect(defineTheme).toHaveBeenCalledWith('github-light', expect.any(Object))
    // vs and vs-dark are built into Monaco, so they don't have custom data
    expect(defineTheme).not.toHaveBeenCalledWith('vs', expect.any(Object))
    expect(defineTheme).not.toHaveBeenCalledWith('vs-dark', expect.any(Object))
  })

  it('resolves editor theme according to dark/light document mode and settings', () => {
    // Default dark
    expect(resolveEditorTheme({ theme: 'dark' })).toBe(DEFAULT_EDITOR_THEME_DARK)
    // Custom dark
    expect(resolveEditorTheme({ theme: 'dark', editorThemeDark: 'dracula' })).toBe('dracula')
    // Invalid dark falls back to default
    expect(resolveEditorTheme({ theme: 'dark', editorThemeDark: 'unknown-theme' })).toBe(
      DEFAULT_EDITOR_THEME_DARK
    )

    // Default light
    expect(resolveEditorTheme({ theme: 'light' })).toBe(DEFAULT_EDITOR_THEME_LIGHT)
    // Custom light
    expect(resolveEditorTheme({ theme: 'light', editorThemeLight: 'github-light' })).toBe(
      'github-light'
    )
    // Invalid light falls back to default
    expect(resolveEditorTheme({ theme: 'light', editorThemeLight: 'unknown-theme' })).toBe(
      DEFAULT_EDITOR_THEME_LIGHT
    )

    // System mode with matchMedia
    expect(
      resolveEditorTheme(
        { theme: 'system', editorThemeDark: 'dracula', editorThemeLight: 'one-light' },
        () => ({ matches: true })
      )
    ).toBe('dracula')

    expect(
      resolveEditorTheme(
        { theme: 'system', editorThemeDark: 'dracula', editorThemeLight: 'one-light' },
        () => ({ matches: false })
      )
    ).toBe('one-light')

    // Explicit isDark boolean parameter
    expect(
      resolveEditorTheme({ editorThemeDark: 'dracula', editorThemeLight: 'one-light' }, true)
    ).toBe('dracula')
    expect(
      resolveEditorTheme({ editorThemeDark: 'dracula', editorThemeLight: 'one-light' }, false)
    ).toBe('one-light')
  })
})
