import type { ITheme } from '@xterm/xterm'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import {
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import {
  composeActiveTerminalTheme,
  composedTerminalThemesEqual
} from '../../../../shared/compose-active-terminal-theme'
import { buildFontFamily } from './layout-serialization'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { canApplyPaneMetricOptions } from '@/lib/pane-manager/pane-fit'
import {
  applyOrDeferPaneMetricOptions,
  paneMetricOptionsAlreadySettled
} from '@/lib/pane-manager/pane-metric-options-deferral'
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PtyTransport } from './pty-transport'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import type { TerminalViewAttributesPush } from '../../../../shared/terminal-view-attributes'
import { publishTerminalViewAttributesSnapshot } from './terminal-view-attributes-snapshot'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { getPaneThemeAgent } from './pane-theme-identity'

export {
  composeActiveTerminalTheme,
  composedTerminalThemesEqual,
  hexToRgba,
  isHexColor
} from '../../../../shared/compose-active-terminal-theme'

/** Publishes the full `{global, byAgent}` snapshot at app start so hidden-at-launch PTYs can query OSC 10/11
 *  before any pane mounts (terminal-query-authority.md §Phase 6). Returns whether a publish went out. */
export function publishTerminalViewAttributesAtAppStart(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  send?: (push: TerminalViewAttributesPush) => boolean
): boolean {
  if (!settings) {
    return false
  }
  return send
    ? publishTerminalViewAttributesSnapshot(settings, systemPrefersDark, send)
    : publishTerminalViewAttributesSnapshot(settings, systemPrefersDark)
}

export function applyTerminalAppearance(
  manager: PaneManager,
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  paneFontSizes: Map<number, number>,
  paneTransports: Map<number, PtyTransport>,
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, 'dark' | 'light'>,
  resolvePaneThemeAgent: (pane: Pick<ManagedPane, 'leafId'>) => TuiAgent | null = (pane) =>
    getPaneThemeAgent(pane.leafId)
): void {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const globalBaseTheme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const globalTheme = composeActiveTerminalTheme(globalBaseTheme, settings)
  // One atomic `{global, byAgent}` snapshot — never a global-only wrapper that would clear agent keys.
  publishTerminalViewAttributesSnapshot(settings, systemPrefersDark)
  const paneBackground = globalTheme?.background ?? '#000000'

  const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)
  const ligaturesEnabled = resolveTerminalLigaturesEnabled(
    settings.terminalLigatures,
    settings.terminalFontFamily
  )

  for (const pane of manager.getPanes()) {
    const agent = resolvePaneThemeAgent(pane)
    const paneAppearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark, agent)
    const paneTheme = composeActiveTerminalTheme(
      paneAppearance.theme ?? getBuiltinTheme(paneAppearance.themeName),
      settings
    )
    // Why value-gated: writing options.theme rebuilds the palette, discarding TUI OSC 4/10/11/12 mutations; skip on no-op change.
    if (paneTheme && !composedTerminalThemesEqual(pane.terminal.options.theme, paneTheme)) {
      pane.terminal.options.theme = paneTheme
    }
    // Gate off the configured theme background; the live OSC-11 background is deliberately preserved by the
    // theme write above, so a TUI that repaints its background at runtime won't re-gate (known limitation).
    // Why value-gated: writing minimumContrastRatio clears xterm's contrast cache, so skip on no-op re-applies.
    const minimumContrastRatio = resolveTerminalMinimumContrastRatio(
      paneTheme?.background,
      paneAppearance.mode
    )
    if (pane.terminal.options.minimumContrastRatio !== minimumContrastRatio) {
      pane.terminal.options.minimumContrastRatio = minimumContrastRatio
    }
    // Why clear explicitly: allowTransparency has rendering cost and a stale `true` could bleed in from a prior opacity.
    pane.terminal.options.allowTransparency =
      settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
    const cursorStyle = settings.terminalCursorStyle ?? 'block'
    pane.terminal.options.cursorStyle = cursorStyle
    pane.terminal.options.cursorInactiveStyle = resolveTerminalCursorInactiveStyle(cursorStyle)
    pane.terminal.options.cursorBlink = settings.terminalCursorBlink
    const paneSize = paneFontSizes.get(pane.id)
    const metricOptions = {
      fontSize: paneSize ?? settings.terminalFontSize,
      fontFamily: buildFontFamily(settings.terminalFontFamily),
      fontWeight: terminalFontWeights.fontWeight,
      fontWeightBold: terminalFontWeights.fontWeightBold,
      lineHeight: normalizeTerminalLineHeight(settings.terminalLineHeight)
    }
    // Why value-gated: any settings write re-runs this over every mounted pane, and
    // canApplyPaneMetricOptions forces style+layout; an unchanged no-op deferral
    // would also arm a pointless refit on the next reveal.
    // Why deferred: a metric write makes xterm clear/resize/full-refresh, which is
    // wasted on a pane with no usable box and whose follow-up cols/rows fit can't run.
    if (!paneMetricOptionsAlreadySettled(pane, metricOptions)) {
      applyOrDeferPaneMetricOptions(pane, metricOptions, canApplyPaneMetricOptions(pane))
    }
    pane.terminal.options.scrollSensitivity = normalizeTerminalScrollSensitivity(
      settings.terminalScrollSensitivity
    )
    pane.terminal.options.fastScrollSensitivity = normalizeTerminalFastScrollSensitivity(
      settings.terminalFastScrollSensitivity
    )
    // Why only 'true': 'left'/'right' are handled in the keydown policy, which needs Option composable at the xterm level.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    // Why unconditional: the helper no-ops when addon state already matches, so this keeps new panes and live toggles in sync.
    manager.setPaneLigaturesEnabled(pane.id, ligaturesEnabled)
    const transport = paneTransports.get(pane.id)
    // Why: PTY is already at phone dimensions under a mobile-fit override — don't resize it back to desktop.
    const appearancePtyId = transport?.getPtyId()
    if (transport?.isConnected() && (!appearancePtyId || !getFitOverrideForPty(appearancePtyId))) {
      maybePushMode2031Flip(pane.id, appearance.mode, transport, paneMode2031, paneLastThemeMode)
      safeFitAndThen(pane, 'appearance-pty-resize', () => {
        const currentTransport = paneTransports.get(pane.id)
        if (
          currentTransport !== transport ||
          !transport.isConnected() ||
          transport.getPtyId() !== appearancePtyId
        ) {
          return
        }
        transport.resize(pane.terminal.cols, pane.terminal.rows)
      })
    } else {
      safeFit(pane)
    }
  }

  manager.setPaneStyleOptions({
    splitBackground: paneBackground,
    paneBackground,
    inactivePaneOpacity: paneStyles.inactivePaneOpacity,
    activePaneOpacity: paneStyles.activePaneOpacity,
    opacityTransitionMs: paneStyles.opacityTransitionMs,
    dividerThicknessPx: paneStyles.dividerThicknessPx,
    focusFollowsMouse: paneStyles.focusFollowsMouse,
    paddingX: settings.terminalPaddingX,
    paddingY: settings.terminalPaddingY
  })
}
