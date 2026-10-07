import type { AppThemePreset, AppThemePresetId } from '../../../shared/app-theme-types'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT
} from '../../../shared/terminal-theme-selection'
import { BRAND_THEME_PRESETS } from './app-theme-brand-presets'
import { STANDARD_THEME_PRESETS } from './app-theme-standard-presets'

export type { AppThemePreset } from '../../../shared/app-theme-types'

export const APP_THEME_PRESETS: readonly AppThemePreset[] = [
  ...STANDARD_THEME_PRESETS,
  ...BRAND_THEME_PRESETS
]

const COMPLEMENTARY_THEME_PAIRS: Readonly<Record<AppThemePresetId, AppThemePresetId>> = {
  default: 'default',
  dracula: 'default',
  nord: 'default',
  'tokyo-night': 'default',
  'catppuccin-mocha': 'catppuccin-latte',
  'catppuccin-latte': 'catppuccin-mocha',
  'solarized-dark': 'solarized-light',
  'solarized-light': 'solarized-dark',
  'github-dark': 'github-light',
  'github-light': 'github-dark',
  'material-dark': 'material-light',
  'material-light': 'material-dark',
  'liquid-glass-dark': 'liquid-glass-light',
  'liquid-glass-light': 'liquid-glass-dark',
  'dala-dark': 'dala-light',
  'dala-light': 'dala-dark',
  'discord-dark': 'discord-light',
  'discord-light': 'discord-dark',
  'dope-security-dark': 'dope-security-light',
  'dope-security-light': 'dope-security-dark',
  'raycast-dark': 'raycast-light',
  'raycast-light': 'raycast-dark',
  'zkpass-dark': 'zkpass-light',
  'zkpass-light': 'zkpass-dark',
  'miranda-light': 'miranda-dark',
  'miranda-dark': 'miranda-light'
}

/**
 * Resolves the effective UI theme preset based on system preferences and light/dark mode.
 */
export function resolveEffectiveThemePreset(
  baseTheme: 'system' | 'dark' | 'light',
  presetId: AppThemePresetId | undefined,
  systemPrefersDark: boolean
): AppThemePresetId {
  if (!presetId || presetId === 'default') {
    return 'default'
  }

  const isEffectiveDark =
    baseTheme === 'dark' ? true : baseTheme === 'light' ? false : systemPrefersDark

  const selectedPreset = APP_THEME_PRESETS.find((p) => p.id === presetId)
  if (!selectedPreset) {
    return 'default'
  }

  const isPresetDark = selectedPreset.mode === 'dark'
  if (isPresetDark === isEffectiveDark) {
    return presetId
  }

  // Preset mode doesn't match effective dark/light mode; switch to counterpart if available.
  const counterpart = COMPLEMENTARY_THEME_PAIRS[presetId]
  return counterpart ?? 'default'
}

/**
 * Returns the matching terminal color scheme name for an interface theme preset and mode.
 */
export function getMatchingTerminalTheme(
  presetId: AppThemePresetId,
  mode: 'dark' | 'light' = 'dark'
): string | undefined {
  if (presetId === 'default') {
    return mode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
  }
  const preset = APP_THEME_PRESETS.find((p) => p.id === presetId)
  return preset?.matchingTerminalTheme
}
