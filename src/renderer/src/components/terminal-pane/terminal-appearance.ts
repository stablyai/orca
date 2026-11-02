import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { resolvePaneStyleOptions, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { buildFontFamily } from '@/lib/monospace-font-family'
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
import { setTerminalCursorBlinkOption } from '@/lib/pane-manager/pane-cursor-blink-suspension'
import type { PtyTransport } from './pty-transport-types'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import { HEX_COLOR_RE } from '../../../../shared/color-validation'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { publishTerminalViewAttributes } from './terminal-view-attributes-publisher'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { resolveTerminalMinimumContrastRatio } from '../../../../shared/terminal-contrast-correction'
import { resolveTerminalInlineImagesEnabled } from '../../../../shared/terminal-inline-images-settings'
import { windowBackdropActive } from '@/lib/window-backdrop'
import { contrastRatio, over, type Rgba } from '@/lib/plugin-theme-tokens'

function hexToRgb(hex: string): Rgba {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return [r, g, b, 1]
}

export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

const LEGACY_SLIDER_GREY: Rgba = [180, 180, 185, 1]

// Why: muted foregrounds (Solarized Dark, One Dark) rise to the old fixed grey's contrast, capped at opaque.
function sliderAlpha(foreground: Rgba, background: Rgba, alpha: number, greyAlpha: number): number {
  const contrastAt = ([r, g, b]: Rgba, a: number): number =>
    contrastRatio(over([r, g, b, a], background), background)
  const floor = contrastAt(LEGACY_SLIDER_GREY, greyAlpha)
  let next = alpha
  while (next < 1 && contrastAt(foreground, next) < floor) {
    next = Math.round(next * 100 + 1) / 100
  }
  return next
}

function foregroundSliderColors(foreground: string, background: string | undefined): ITheme {
  const fg = hexToRgb(foreground)
  const bg = background && isHexColor(background) ? hexToRgb(background) : null
  const tint = (alpha: number, greyAlpha: number): string =>
    hexToRgba(foreground, bg ? sliderAlpha(fg, bg, alpha, greyAlpha) : alpha)
  return {
    scrollbarSliderBackground: tint(0.35, 0.4),
    scrollbarSliderHoverBackground: tint(0.55, 0.6),
    scrollbarSliderActiveBackground: tint(0.7, 0.8)
  }
}

// Keep pure so settings preview can compose the same theme without PaneManager. baseTheme is the resolved palette
// (resolveEffectiveTerminalAppearance), which already carries the slot's color overrides.
export function composeActiveTerminalTheme(
  baseTheme: ITheme | null,
  settings: Pick<GlobalSettings, 'terminalBackgroundOpacity' | 'terminalCursorOpacity'>
): ITheme | null {
  if (!baseTheme) {
    return null
  }
  // Why transparent ruler border: scrollbar.width enables xterm's overview ruler, whose border would paint a bright line.
  // Why foreground-tinted thumb: a fixed grey vanished on light themes (#12635); xterm derives non-hex ones. Theme wins.
  const foreground = baseTheme.foreground
  let theme: ITheme = {
    overviewRulerBorder: 'transparent',
    ...(foreground && isHexColor(foreground)
      ? foregroundSliderColors(foreground, baseTheme.background)
      : {}),
    ...baseTheme
  }
  // Why: convert the hex background to rgba so xterm honors the opacity when allowTransparency is set.
  if (settings.terminalBackgroundOpacity !== undefined && theme.background) {
    theme = {
      ...theme,
      background: hexToRgba(theme.background, settings.terminalBackgroundOpacity)
    }
  }
  // Why hex-only: hexToRgba expects a hex input, so named CSS cursor colors are left untouched.
  if (settings.terminalCursorOpacity !== undefined && theme.cursor && isHexColor(theme.cursor)) {
    theme = {
      ...theme,
      cursor: hexToRgba(theme.cursor, settings.terminalCursorOpacity)
    }
  }
  return theme
}

/** Publish at startup so hidden-at-launch PTYs can query OSC 10/11 before any pane mounts; returns whether sent (terminal-query-authority.md). */
export function publishTerminalViewAttributesAtAppStart(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  send?: (attributes: TerminalViewAttributes) => boolean
): boolean {
  if (!settings) {
    return false
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const theme = composeActiveTerminalTheme(appearance.theme, settings)
  return send !== undefined
    ? publishTerminalViewAttributes(theme, appearance.mode, settings, send)
    : publishTerminalViewAttributes(theme, appearance.mode, settings)
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
  paneFontSizes: Map<number, number>,
  paneTransports: Map<number, PtyTransport>,
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, 'dark' | 'light'>
): void {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const theme = composeActiveTerminalTheme(appearance.theme, settings)
  publishTerminalViewAttributes(theme, appearance.mode, settings)
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
    const paneSize = paneFontSizes.get(pane.id)
    const metricOptions = {
      fontSize: paneSize ?? settings.terminalFontSize,
      fontFamily: buildFontFamily(settings.terminalFontFamily),
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
