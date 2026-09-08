import { useMemo } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { monaco } from '@/lib/monaco-setup'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { ensureMonacoTerminalAlignedTheme } from '@/lib/monaco-terminal-aligned-theme'

/** Resolves the Monaco theme name for the file editor / diff viewer: the plain light/dark
 *  editor theme, or (when `editorThemeMatchesTerminal` is on) one mirroring the active terminal theme. */
export function useMonacoTerminalAlignedTheme(
  settings: GlobalSettings | null | undefined,
  isDark: boolean
): string {
  return useMemo(() => {
    const defaultThemeName = isDark ? 'vs-dark' : 'vs'
    if (!settings?.editorThemeMatchesTerminal) {
      return defaultThemeName
    }
    const terminalAppearance = resolveEffectiveTerminalAppearance(settings)
    if (!terminalAppearance.theme) {
      return defaultThemeName
    }
    return ensureMonacoTerminalAlignedTheme(
      monaco,
      terminalAppearance.themeName,
      terminalAppearance.theme
    )
  }, [isDark, settings])
}
