import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { resolveTerminalFontWeights } from '../../../../../shared/terminal/appearance/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../../shared/terminal/appearance/terminal-ligatures'
import {
  applyRepoTerminalThemeOverride,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal/appearance/terminal-theme'
import type { RepoTerminalThemeOverrides } from '../../../../../shared/repo-terminal-theme'
import { buildFontFamily } from '../../../../../shared/monospace-font-family'
import { pluginFontFamilyWhenLoaded } from '@/store/plugins/appearance/plugin-fonts'
import '@/lib/pane-manager/pane-layout/pane-tree-ops'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/terminal-fit/pane-fit'

import { canApplyPaneMetricOptions } from '@/lib/pane-manager/terminal-fit/pane-fit-measurability'
import {
  applyOrDeferPaneMetricOptions,
  paneMetricOptionsAlreadySettled
} from '@/lib/pane-manager/terminal-fit/pane-metric-options-deferral'
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle,
  resolveTerminalScrollOnUserInput
} from '@/lib/pane-manager/pane-terminal-options'
import { getFitOverrideForPty } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { setTerminalCursorBlinkOption } from '@/lib/pane-manager/pane-focus/pane-cursor-blink-suspension'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import type { TerminalViewAttributes } from '../../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import {
  hexToRgba,
  composeActiveTerminalTheme,
  isHexColor
} from '../../../../../shared/terminal-view-attributes-composition'
import { publishTerminalViewAttributesFromSettings } from './terminal-view-attributes-publisher'
import { normalizeTerminalLineHeight } from '../../../../../shared/terminal/appearance/terminal-line-height-settings'
import { maybePushMode2031Flip } from '../emulation/terminal-mode-2031-replies'
import { resolveTerminalMinimumContrastRatio } from '../../../../../shared/terminal-themes/terminal-contrast-correction'
import { resolveTerminalInlineImagesEnabled } from '../../../../../shared/terminal/images/terminal-inline-images-settings'
import { windowBackdropActive } from '@/app-shell/appearance/window-backdrop'
import { getTerminalFontSizeOverride } from './terminal-font-size-overrides'

// Why shared: main composes the same theme from persisted settings to pre-load hidden PTYs.
export { composeActiveTerminalTheme, hexToRgba, isHexColor }

/** Publish at startup so hidden-at-launch PTYs can query OSC 10/11 before any pane mounts; returns whether sent (terminal-query-authority.md). */
export function publishTerminalViewAttributesAtAppStart(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  send?: (attributes: TerminalViewAttributes) => boolean
): boolean {
  if (!settings) {
    return false
  }
  return send !== undefined
    ? publishTerminalViewAttributesFromSettings(settings, systemPrefersDark, send)
    : publishTerminalViewAttributesFromSettings(settings, systemPrefersDark)
}

// Value equality over composed ITheme objects (flat string slots plus the extendedAnsi array); gates the options.theme write.
function composedTerminalThemesEqual(a: ITheme | undefined, b: ITheme): boolean {
  if (!a) {
    return false
  }
  if (a === b) {
    return true
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (key === 'extendedAnsi') {
      continue
    }
    if (a[key as keyof ITheme] !== b[key as keyof ITheme]) {
      return false
    }
  }
  const extA = a.extendedAnsi
  const extB = b.extendedAnsi
  if (!extA || !extB) {
    return extA === extB
  }
  return extA.length === extB.length && extA.every((value, i) => value === extB[i])
}

export function applyTerminalAppearance(
  manager: PaneManager,
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  paneTransports: Map<number, PtyTransport>,
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, 'dark' | 'light'>,
  repoTerminalTheme?: RepoTerminalThemeOverrides
): void {
  const paneSettings = applyRepoTerminalThemeOverride(settings, repoTerminalTheme)
  const appearance = resolveEffectiveTerminalAppearance(paneSettings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const theme = composeActiveTerminalTheme(appearance.theme, paneSettings)
  publishTerminalViewAttributesAtAppStart(settings, systemPrefersDark)
  const paneBackground = theme?.background ?? '#000000'
  // Why: over a window backdrop the split root is the one translucent paint; xterm's viewport,
  // scrollable element and canvas each repainting it compounded 0.82 to ~0.99 (#36196).
  const backdropActive = windowBackdropActive()
  const xtermTheme = backdropActive
    ? composeActiveTerminalTheme(appearance.theme, { ...settings, terminalBackgroundOpacity: 0 })
    : theme

  const terminalFontWeights = resolveTerminalFontWeights(
    settings.terminalFontWeight,
    settings.terminalFontWeightBold
  )
  const ligaturesEnabled = resolveTerminalLigaturesEnabled(
    settings.terminalLigatures,
    settings.terminalFontFamily
  )

  for (const pane of manager.getPanes()) {
    // Why value-gated: writing options.theme rebuilds the palette, discarding TUI OSC 4/10/11/12 mutations; skip on no-op change.
    if (xtermTheme && !composedTerminalThemesEqual(pane.terminal.options.theme, xtermTheme)) {
      pane.terminal.options.theme = xtermTheme
    }
    // Use configured background: preserving live OSC-11 mutations above means a TUI background change does not re-gate contrast.
    const minimumContrastRatio = resolveTerminalMinimumContrastRatio(
      theme?.background,
      appearance.mode,
      settings.terminalMinimumContrastRatio
    )
    if (pane.terminal.options.minimumContrastRatio !== minimumContrastRatio) {
      pane.terminal.options.minimumContrastRatio = minimumContrastRatio
    }
    // Why clear explicitly: allowTransparency has rendering cost and a stale `true` could bleed in from a prior opacity.
    pane.terminal.options.allowTransparency =
      backdropActive ||
      (settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1)
    const cursorStyle = settings.terminalCursorStyle ?? 'block'
    pane.terminal.options.cursorStyle = cursorStyle
    pane.terminal.options.cursorInactiveStyle = resolveTerminalCursorInactiveStyle(cursorStyle)
    // Hidden panes defer cursor blink so settings changes cannot restart their blink timer.
    setTerminalCursorBlinkOption(pane.terminal, settings.terminalCursorBlink)
    const paneSize = getTerminalFontSizeOverride(pane.leafId)
    const metricOptions = {
      fontSize: paneSize ?? settings.terminalFontSize,
      fontFamily: buildFontFamily(pluginFontFamilyWhenLoaded(settings.terminalFontFamily)),
      fontWeight: terminalFontWeights.fontWeight,
      fontWeightBold: terminalFontWeights.fontWeightBold,
      lineHeight: normalizeTerminalLineHeight(settings.terminalLineHeight)
    }
    // Skip unchanged metrics: checking measurability forces layout and a no-op deferral needlessly schedules refit.
    // Defer metric-triggered clear/resize/refresh until the pane can measure and fit.
    if (!paneMetricOptionsAlreadySettled(pane, metricOptions)) {
      applyOrDeferPaneMetricOptions(pane, metricOptions, canApplyPaneMetricOptions(pane))
    }
    pane.terminal.options.scrollSensitivity = normalizeTerminalScrollSensitivity(
      settings.terminalScrollSensitivity
    )
    pane.terminal.options.fastScrollSensitivity = normalizeTerminalFastScrollSensitivity(
      settings.terminalFastScrollSensitivity
    )
    pane.terminal.options.scrollOnUserInput = resolveTerminalScrollOnUserInput(
      settings.terminalScrollOnUserInput
    )
    // Why only 'true': 'left'/'right' are handled in the keydown policy, which needs Option composable at the xterm level.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    manager.setPaneLigaturesEnabled(pane.id, ligaturesEnabled)
    manager.setPaneInlineImagesEnabled(
      pane.id,
      resolveTerminalInlineImagesEnabled(settings.terminalInlineImages)
    )
    const transport = paneTransports.get(pane.id)
    if (transport) {
      maybePushMode2031Flip(pane.id, appearance.mode, transport, paneMode2031, paneLastThemeMode)
    }
    // Why: PTY is already at phone dimensions under a mobile-fit override — don't resize it back to desktop.
    const appearancePtyId = transport?.getPtyId()
    if (transport?.isConnected() && (!appearancePtyId || !getFitOverrideForPty(appearancePtyId))) {
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
    inactivePaneOpacity: paneStyles.inactivePaneOpacity,
    activePaneOpacity: paneStyles.activePaneOpacity,
    opacityTransitionMs: paneStyles.opacityTransitionMs,
    dividerThicknessPx: paneStyles.dividerThicknessPx,
    focusFollowsMouse: paneStyles.focusFollowsMouse,
    paddingX: settings.terminalPaddingX,
    paddingY: settings.terminalPaddingY
  })
}
