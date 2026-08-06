import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import {
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { buildFontFamily } from './layout-serialization'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PtyTransport } from './pty-transport'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import { HEX_COLOR_RE } from '../../../../shared/color-validation'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { publishTerminalViewAttributes } from './terminal-view-attributes-publisher'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'

export function hexToRgba(hex: string, alpha: number): string {
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
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

// Why extracted: lets the settings preview compose the same theme without depending on PaneManager. Keep pure.
export function composeActiveTerminalTheme(
  baseTheme: ITheme | null,
  settings: Pick<
    GlobalSettings,
    'terminalColorOverrides' | 'terminalBackgroundOpacity' | 'terminalCursorOpacity'
  >
): ITheme | null {
  if (!baseTheme) {
    return null
  }
  // Why transparent ruler border: scrollbar.width enables xterm's overview ruler, whose border would paint a bright line.
  // Why raised slider alpha: xterm's default (~0.2) is nearly invisible on dark bg. Before the spread so explicit theme wins.
  let theme: ITheme = {
    overviewRulerBorder: 'transparent',
    scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
    scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
    ...baseTheme
  }
  // Why: merge Ghostty color overrides atop the base theme so individual colors can be tweaked without losing the rest.
  if (settings.terminalColorOverrides) {
    theme = { ...theme, ...settings.terminalColorOverrides }
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

/** Publishes composed terminal appearance at app start so hidden-at-launch PTYs can query OSC 10/11
 *  before any pane mounts (terminal-query-authority.md §Phase 6). Returns whether a publish went out. */
export function publishTerminalViewAttributesAtAppStart(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  send?: (attributes: TerminalViewAttributes) => boolean
): boolean {
  if (!settings) {
    return false
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const baseTheme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const theme = composeActiveTerminalTheme(baseTheme, settings)
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
  const baseTheme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const theme = composeActiveTerminalTheme(baseTheme, settings)
  // Publish composed appearance to main's hidden-PTY query responder — the only point it exists; deduped in the publisher.
  publishTerminalViewAttributes(theme, appearance.mode, settings)
  const paneBackground = theme?.background ?? '#000000'

  const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)
  const ligaturesEnabled = resolveTerminalLigaturesEnabled(
    settings.terminalLigatures,
    settings.terminalFontFamily
  )

  for (const pane of manager.getPanes()) {
    // Why value-gated: writing options.theme rebuilds the palette, discarding TUI OSC 4/10/11/12 mutations; skip on no-op change.
    if (theme && !composedTerminalThemesEqual(pane.terminal.options.theme, theme)) {
      pane.terminal.options.theme = theme
    }
    // Gate off the configured theme background; the live OSC-11 background is deliberately preserved by the
    // theme write above, so a TUI that repaints its background at runtime won't re-gate (known limitation).
    // Why value-gated: writing minimumContrastRatio clears xterm's contrast cache, so skip on no-op re-applies.
    const minimumContrastRatio = resolveTerminalMinimumContrastRatio(
      theme?.background,
      appearance.mode
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
    pane.terminal.options.fontSize = paneSize ?? settings.terminalFontSize
    pane.terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily)
    pane.terminal.options.fontWeight = terminalFontWeights.fontWeight
    pane.terminal.options.fontWeightBold = terminalFontWeights.fontWeightBold
    pane.terminal.options.scrollSensitivity = normalizeTerminalScrollSensitivity(
      settings.terminalScrollSensitivity
    )
    pane.terminal.options.fastScrollSensitivity = normalizeTerminalFastScrollSensitivity(
      settings.terminalFastScrollSensitivity
    )
    // Why only 'true': 'left'/'right' are handled in the keydown policy, which needs Option composable at the xterm level.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    pane.terminal.options.lineHeight = normalizeTerminalLineHeight(settings.terminalLineHeight)
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
