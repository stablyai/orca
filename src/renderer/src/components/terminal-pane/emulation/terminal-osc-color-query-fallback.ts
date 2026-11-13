import type { TerminalOscColorQueryReplyColors } from '../../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import { DEFAULT_TERMINAL_THEMES } from '../../../../../shared/terminal-themes/defaults'
import { DEFAULT_TERMINAL_THEME_DARK } from '../../../../../shared/terminal-themes/terminal-theme-selection'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { composeActiveTerminalTheme } from '../appearance/terminal-appearance'
import { getSystemPrefersDark, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'

const BUILTIN_DARK_FALLBACK = DEFAULT_TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_DARK]

/** Composed pane appearance colors for OSC 10/11 when `options.theme` lost fg/bg slots. */
export function resolveTerminalOscColorQueryFallback(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark = getSystemPrefersDark()
): TerminalOscColorQueryReplyColors {
  if (!settings) {
    return {
      foreground: BUILTIN_DARK_FALLBACK.foreground,
      background: BUILTIN_DARK_FALLBACK.background
    }
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const theme = composeActiveTerminalTheme(appearance.theme, settings)
  return {
    foreground: theme?.foreground ?? BUILTIN_DARK_FALLBACK.foreground,
    background: theme?.background ?? BUILTIN_DARK_FALLBACK.background
  }
}
