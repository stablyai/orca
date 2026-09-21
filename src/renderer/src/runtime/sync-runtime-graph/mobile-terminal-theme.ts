import { getSystemPrefersDark, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/runtime-types'
import { graphState } from './graph-state'
import { normalizeTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'

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
    // Why publish: mobile mirrors the desktop contrast gate, so an explicit floor has to travel with
    // the theme or the same session would render differently on the phone (#10754).
    minimumContrastRatio: normalizeTerminalMinimumContrastRatio(
      settings.terminalMinimumContrastRatio
    )
  }
}

export function getMobileTerminalTheme(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileTerminalTheme | undefined {
  if (
    graphState.hasCachedMobileTerminalTheme &&
    graphState.cachedMobileTerminalThemeSettings === state.settings &&
    graphState.cachedMobileTerminalThemeSystemPrefersDark === systemPrefersDark
  ) {
    return graphState.cachedMobileTerminalTheme
  }
  graphState.cachedMobileTerminalTheme = resolveMobileTerminalTheme(state, systemPrefersDark)
  graphState.cachedMobileTerminalThemeSettings = state.settings
  graphState.cachedMobileTerminalThemeSystemPrefersDark = systemPrefersDark
  graphState.hasCachedMobileTerminalTheme = true
  return graphState.cachedMobileTerminalTheme
}
