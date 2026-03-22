import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/types'
import {
  getCursorStyleSequence,
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type { PtyTransport } from './pty-transport'

export function applyTerminalAppearance(
  manager: PaneManager,
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  paneFontSizes: Map<number, number>,
  paneTransports: Map<number, PtyTransport>
): void {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const cursorSequence = getCursorStyleSequence(
    settings.terminalCursorStyle,
    settings.terminalCursorBlink
  )
  const theme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const paneBackground = theme?.background ?? '#000000'

  for (const pane of manager.getPanes()) {
    if (theme) {
      pane.terminal.options.theme = theme
    }
    pane.terminal.options.cursorStyle = settings.terminalCursorStyle
    pane.terminal.options.cursorBlink = settings.terminalCursorBlink
    const paneSize = paneFontSizes.get(pane.id)
    pane.terminal.options.fontSize = paneSize ?? settings.terminalFontSize
    try {
      pane.fitAddon.fit()
    } catch {
      /* ignore */
    }
    const transport = paneTransports.get(pane.id)
    transport?.sendInput(cursorSequence)
  }

  manager.setPaneStyleOptions({
    splitBackground: paneBackground,
    paneBackground,
    inactivePaneOpacity: paneStyles.inactivePaneOpacity,
    activePaneOpacity: paneStyles.activePaneOpacity,
    opacityTransitionMs: paneStyles.opacityTransitionMs,
    dividerThicknessPx: paneStyles.dividerThicknessPx
  })
}
