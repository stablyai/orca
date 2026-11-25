import { getSystemPrefersDark } from '@/lib/terminal/appearance/terminal-theme'
import { resolveMobileTerminalTheme } from '../../../../shared/terminal-themes/mobile-terminal-theme'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'

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
  cachedMobileTerminalTheme = resolveMobileTerminalTheme(state.settings, systemPrefersDark)
  cachedMobileTerminalThemeSettings = state.settings
  cachedMobileTerminalThemeSystemPrefersDark = systemPrefersDark
  hasCachedMobileTerminalTheme = true
  return cachedMobileTerminalTheme
}
