import { useEffect, useMemo } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { MacOptionAsAlt } from '@/components/terminal-pane/terminal-shortcut-policy'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { buildPreviewAppearanceOptions } from './preview-terminal-options'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'

/** The effective theme for a preview; memoised because it keys the terminal's mount effect. */
export function usePreviewTerminalTheme(
  settings: GlobalSettings | null,
  systemPrefersDark: boolean
): {
  terminalTheme: ReturnType<typeof composeActiveTerminalTheme> | null
  terminalMode: 'light' | 'dark'
} {
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

/** Applies appearance in place (a remount reconnects the pty and repaints); a font change moves the cell size, so fit and claim re-measure. */
export function usePreviewTerminalAppearanceSync(args: {
  terminalRef: React.RefObject<Terminal | null>
  settings: GlobalSettings | null
  macOptionAsAlt: MacOptionAsAlt
  fontSize: number | undefined
  scheduleFitRef: React.RefObject<(() => void) | null>
  gridClaimScheduleRef: React.RefObject<(() => void) | null>
}): void {
  const { terminalRef, settings, macOptionAsAlt, fontSize, scheduleFitRef, gridClaimScheduleRef } =
    args
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    Object.assign(
      terminal.options,
      buildPreviewAppearanceOptions(settings, macOptionAsAlt === 'true', fontSize)
    )
    syncPreviewTerminalLigatures(terminal, settings)
    scheduleFitRef.current?.()
    gridClaimScheduleRef.current?.()
  }, [terminalRef, settings, macOptionAsAlt, fontSize, scheduleFitRef, gridClaimScheduleRef])
}
