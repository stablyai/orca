import { useMemo } from 'react'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import type { GlobalSettings } from '../../../../shared/types'

// Why: a remote terminal renders with the local appearance settings, same as a
// workspace pane — the host's theme never crosses the wire.
export function useRemoteTerminalTheme(settings: GlobalSettings | null | undefined): {
  terminalTheme: ReturnType<typeof composeActiveTerminalTheme> | null
  terminalMode: 'dark' | 'light'
} {
  const systemPrefersDark = useSystemPrefersDark()
  return useMemo(() => {
    if (!settings) {
      return { terminalTheme: null, terminalMode: 'dark' as const }
    }
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    const theme = composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    )
    return { terminalTheme: theme, terminalMode: appearance.mode }
  }, [settings, systemPrefersDark])
}
