import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/types'
import {
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { buildFontFamily } from './layout-serialization'
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
    pane.terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily)
    try {
      pane.fitAddon.fit()
    } catch {
      /* ignore */
    }
    const transport = paneTransports.get(pane.id)
    if (transport?.isConnected()) {
      transport.resize(pane.terminal.cols, pane.terminal.rows)
    }
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
