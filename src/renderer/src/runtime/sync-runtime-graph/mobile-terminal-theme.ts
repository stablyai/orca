import { getSystemPrefersDark, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/runtime-types'
import { normalizeTerminalMinimumContrastRatio } from '../../../../shared/terminal-contrast-correction'

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((character) => character + character)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

export function resolveMobileTerminalTheme(
  state: AppState,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  const settings = state.settings
  if (!settings) {
    return undefined
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const resolvedTheme = appearance.theme
    ? { ...appearance.theme, ...settings.terminalColorOverrides }
    : undefined
  if (!resolvedTheme) {
    return undefined
  }
  if (settings.terminalBackgroundOpacity !== undefined && isHexColor(resolvedTheme.background)) {
    resolvedTheme.background = hexToRgba(
      resolvedTheme.background,
      settings.terminalBackgroundOpacity
    )
  }
  if (settings.terminalCursorOpacity !== undefined && isHexColor(resolvedTheme.cursor)) {
    resolvedTheme.cursor = hexToRgba(resolvedTheme.cursor, settings.terminalCursorOpacity)
  }

  const theme: Record<string, string> = {}
  for (const [key, value] of Object.entries(resolvedTheme)) {
    if (typeof value === 'string') {
      theme[key] = value
    }
  }
  return {
    mode: appearance.mode,
    theme: theme as RuntimeMobileTerminalTheme['theme'],
    // Send explicit contrast floor so mobile matches desktop rendering (#10754).
    minimumContrastRatio: normalizeTerminalMinimumContrastRatio(
      settings.terminalMinimumContrastRatio
    )
  }
}

let cachedMobileTerminalThemeSettings: AppState['settings'] | null = null
let cachedMobileTerminalThemeSystemPrefersDark: boolean | null = null
let cachedMobileTerminalTheme: RuntimeMobileTerminalTheme | undefined
let hasCachedMobileTerminalTheme = false

export function getMobileTerminalTheme(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileTerminalTheme | undefined {
  if (
    hasCachedMobileTerminalTheme &&
    cachedMobileTerminalThemeSettings === state.settings &&
    cachedMobileTerminalThemeSystemPrefersDark === systemPrefersDark
  ) {
    return cachedMobileTerminalTheme
  }
  cachedMobileTerminalTheme = resolveMobileTerminalTheme(state, systemPrefersDark)
  cachedMobileTerminalThemeSettings = state.settings
  cachedMobileTerminalThemeSystemPrefersDark = systemPrefersDark
  hasCachedMobileTerminalTheme = true
  return cachedMobileTerminalTheme
}
