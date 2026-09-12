import { getSystemPrefersDark } from '@/lib/terminal-theme'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/runtime-types'
import { resolveRuntimeMobileTerminalTheme } from '../../../../shared/runtime-mobile-terminal-theme'
import { graphState } from './graph-state'

export function resolveMobileTerminalTheme(
  state: AppState,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  return resolveRuntimeMobileTerminalTheme(state.settings, systemPrefersDark)
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
