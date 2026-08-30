import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { buildPreviewAppearanceOptions } from './preview-terminal-options'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import type { ITheme, Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type PreviewTerminalAppearance = {
  terminalTheme: ITheme | null
  terminalMode: 'dark' | 'light'
}

/** The pane appearance a preview terminal opens with. Recreating the terminal
 *  reconnects the pty, so this must resolve to the same value across renders
 *  that change nothing about the theme. */
export function resolvePreviewTerminalAppearance(
  settings: GlobalSettings | null,
  systemPrefersDark: boolean
): PreviewTerminalAppearance {
  if (!settings) {
    return { terminalTheme: null, terminalMode: 'dark' }
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  return {
    terminalTheme: composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    ),
    terminalMode: appearance.mode
  }
}

/** Lands changed appearance settings on an already-open preview terminal — a
 *  remount would reconnect the pty and repaint from a new snapshot. */
export function applyPreviewTerminalAppearance(
  terminal: Terminal,
  settings: GlobalSettings | null,
  macOptionAsAlt: boolean
): void {
  Object.assign(terminal.options, buildPreviewAppearanceOptions(settings, macOptionAsAlt))
  syncPreviewTerminalLigatures(terminal, settings)
}
