import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { buildFontFamily } from './layout-serialization'
import { captureScrollState, restoreScrollState } from '@/lib/pane-manager/pane-tree-ops'
import type { PtyTransport } from './pty-transport'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'

export function applyTerminalAppearance(
  manager: PaneManager,
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  paneFontSizes: Map<number, number>,
  paneTransports: Map<number, PtyTransport>,
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
): void {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const theme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const paneBackground = theme?.background ?? '#000000'
  const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)

  for (const pane of manager.getPanes()) {
    if (theme) {
      pane.terminal.options.theme = theme
    }
    pane.terminal.options.cursorStyle = settings.terminalCursorStyle
    pane.terminal.options.cursorBlink = settings.terminalCursorBlink
    const paneSize = paneFontSizes.get(pane.id)
    pane.terminal.options.fontSize = paneSize ?? settings.terminalFontSize
    pane.terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily)
    pane.terminal.options.fontWeight = terminalFontWeights.fontWeight
    pane.terminal.options.fontWeightBold = terminalFontWeights.fontWeightBold
    // Why: xterm's macOptionIsMeta only flips on the 'true' mode. 'left' and
    // 'right' are handled in the keydown policy (terminal-shortcut-policy),
    // which needs Option to stay composable at the xterm level for the
    // non-Meta side. Treating only 'true' as Meta here matches the pre-
    // detection behavior; the detection layer simply decides *what* value
    // `effectiveMacOptionAsAlt` carries.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    pane.terminal.options.lineHeight = settings.terminalLineHeight
    try {
      const state = captureScrollState(pane.terminal)
      pane.fitAddon.fit()
      restoreScrollState(pane.terminal, state)
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
    dividerThicknessPx: paneStyles.dividerThicknessPx,
    focusFollowsMouse: paneStyles.focusFollowsMouse
  })
}
