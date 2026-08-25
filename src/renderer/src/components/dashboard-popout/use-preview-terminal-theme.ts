import { useMemo } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'

export function usePreviewTerminalTheme(settings: GlobalSettings | null): {
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
