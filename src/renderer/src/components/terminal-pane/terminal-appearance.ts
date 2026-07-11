import type { IDisposable, IParser, ITheme } from '@xterm/xterm'
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
import { guardParserHandler } from './terminal-parser-handler-guard'
import { captureScrollState, restoreScrollState, safeFit } from '@/lib/pane-manager/pane-tree-ops'
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

// Why Pick<IParser, ...> over a hand-rolled structural type: keeps the helper
// tied to xterm's canonical signature so any upstream tightening (added
// fields on IFunctionIdentifier, narrower param type) surfaces here instead
// of silently accepting a stale shape.
type Mode2031Parser = Pick<IParser, 'registerCsiHandler'>

type Mode2031HandlerDeps = {
  paneId: number
  parser: Mode2031Parser
  /** Called when a real (non-replayed) `CSI ?2031h` arrives, after the
   *  subscribe flag has been set. Kept as a callback so the lifecycle hook
   *  can keep its transport-aware `pushMode2031ForPane` closure intact. */
  onSubscribe: () => void
  isReplaying: () => boolean
  paneMode2031: Map<number, boolean>
  paneLastThemeMode: Map<number, 'dark' | 'light'>
}

// Why split out from the lifecycle hook: the CSI handlers are the defense
// against a restored xterm buffer pushing `\x1b[?997;1n` into the fresh zsh
// on cold restore (the "random characters on restart" bug). Keeping them in
// a pure function lets the tests drive a real xterm parser end-to-end so we
// catch regressions in the parser-path guard, not just a mock.
export function installMode2031Handlers(deps: Mode2031HandlerDeps): IDisposable[] {
  const hasMode2031 = (params: (number | number[])[]): boolean =>
    params.some((p) => (Array.isArray(p) ? p.includes(2031) : p === 2031))

  // Why return false from both handlers: we only observe mode 2031.
  // Returning false lets xterm's built-in DEC private mode handler
  // continue processing the same sequence, so compound sequences like
  // `CSI ?25;2031h` still update cursor visibility correctly.
  return [
    deps.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      guardParserHandler('csi-mode2031-subscribe', (params) => {
        if (hasMode2031(params)) {
          // Why: a restored xterm buffer may contain `CSI ?2031h` emitted by
          // the previous session's TUI (e.g. Claude Code). Replaying that
          // buffer runs this handler, and without the guard we'd push
          // `CSI ?997;1n` via transport.sendInput into a fresh shell that has
          // no TUI consuming it — zsh then echoes the literal escape sequence
          // onto the prompt. The replay guard in pty-connection.ts only covers
          // xterm's own onData auto-replies, not handler-triggered sends, so
          // gate explicitly here. We also skip recording the subscribe bit:
          // the fresh shell is not actually subscribed, so a later theme flip
          // must not push either. A real TUI that starts up after restore will
          // re-emit `?2031h` itself and register normally.
          //
          // Why this broad guard is safe across all replay sources: the only
          // replay path that can carry raw `?2031h` is cold-restore scrollback
          // (pty-connection.ts), which is disk-replayed PTY output against a
          // fresh shell — the case this guard targets. Daemon snapshot payloads
          // (`rehydrateSequences + SerializeAddon.serialize()`) and persisted
          // scrollback (`SerializeAddon.serialize()`) never contain `?2031`:
          // SerializeAddon's _serializeModes whitelists only ?1h/?66h/?2004h/
          // [4h/?6h/?45h/?1004h/?7l/mouse modes/?25l, and buildRehydrateSequences
          // emits only ?1049h/?2004h/?1h/mouse reporting modes. If xterm ever
          // adds ?2031 to that whitelist, this guard would start suppressing
          // legitimate subscribes during snapshot reattach — revisit then.
          if (deps.isReplaying()) {
            return false
          }
          deps.paneMode2031.set(deps.paneId, true)
          deps.onSubscribe()
        }
        return false
      })
    ),
    // Why no replay guard on the unsubscribe branch: clearing stale bookkeeping
    // is harmless. We only push CSI 997 on subscribe, never on unsubscribe, so
    // even if a cold-restore replay carries `?2031l`, this handler just deletes
    // map entries that a later real `?2031h` will re-populate normally.
    deps.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      guardParserHandler('csi-mode2031-unsubscribe', (params) => {
        if (hasMode2031(params)) {
          deps.paneMode2031.delete(deps.paneId)
          deps.paneLastThemeMode.delete(deps.paneId)
        }
        return false
      })
    )
  ]
}

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

// Why: extracted from applyTerminalAppearance so the settings preview can
// derive the same composed theme without depending on PaneManager. Keep
// pure — no DOM, no manager, no side effects.
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
  // Why: setting scrollbar.width enables xterm's overview ruler, whose border
  // defaults to the foreground color and paints a bright vertical line beside
  // the scrollbar. We only want the slimmer scrollbar, not the ruler chrome.
  // Why: xterm's default slider alpha (~0.2) is nearly invisible on dark
  // backgrounds; raise the contrast so the thumb reads. Placed before the
  // spread so an explicit theme value still wins.
  let theme: ITheme = {
    overviewRulerBorder: 'transparent',
    scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
    scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
    ...baseTheme
  }
  // Why: merge user-imported Ghostty color overrides on top of the resolved
  // base theme so individual colors can be tweaked without losing the rest.
  if (settings.terminalColorOverrides) {
    theme = { ...theme, ...settings.terminalColorOverrides }
  }
  // Why: Ghostty's background-opacity controls the terminal's base alpha.
  // Convert the hex background to rgba so xterm honors it when allowTransparency
  // is also set on the Terminal instance.
  if (settings.terminalBackgroundOpacity !== undefined && theme.background) {
    theme = {
      ...theme,
      background: hexToRgba(theme.background, settings.terminalBackgroundOpacity)
    }
  }
  // Why: Ghostty's cursor-opacity applies alpha to the cursor color. Only
  // converted when the resolved cursor is a hex value; named CSS colors are
  // left untouched because hexToRgba expects a hex input.
  if (settings.terminalCursorOpacity !== undefined && theme.cursor && isHexColor(theme.cursor)) {
    theme = {
      ...theme,
      cursor: hexToRgba(theme.cursor, settings.terminalCursorOpacity)
    }
  }
  return theme
}

/** App-start publication (terminal-query-authority.md §Phase 6
 *  prerequisites): hidden-at-launch PTYs can query OSC 10/11 before any
 *  terminal pane mounts, and main's responder is silent-until-first-push.
 *  Composes the same theme applyTerminalAppearance would and publishes it
 *  through the same deduped publisher, so the later pane-mount apply is a
 *  no-op re-push. Returns whether a publish actually went out. */
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

// Value equality over composed ITheme objects (flat string slots plus the
// extendedAnsi string array), used to gate the per-pane options.theme write.
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
  // View-attribute bridge (Phase 5 slice 2): this is the single point where
  // the composed app-global terminal appearance exists, so publish it to
  // main's hidden-PTY query responder here. Deduped inside the publisher —
  // per-pane re-applies and attribute-neutral tweaks do not re-push.
  publishTerminalViewAttributes(theme, appearance.mode, settings)
  const paneBackground = theme?.background ?? '#000000'

  const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)
  const ligaturesEnabled = resolveTerminalLigaturesEnabled(
    settings.terminalLigatures,
    settings.terminalFontFamily
  )

  for (const pane of manager.getPanes()) {
    // Why value-gated: xterm's OptionsService fires on object identity, and
    // ThemeService._setTheme rebuilds the palette, discarding TUI OSC
    // 4/10/11/12 SET mutations. Attribute-neutral applies (font size/family,
    // line height, padding, per-pane zoom) compose a fresh-but-identical
    // theme; skipping the write keeps visible-pane mutations alive (a
    // pre-existing loss this also fixes) and matches the hidden responder's
    // deduped overlay behavior, so hidden and visible no longer drift.
    if (theme && !composedTerminalThemesEqual(pane.terminal.options.theme, theme)) {
      pane.terminal.options.theme = theme
    }
    // Why: xterm's allowTransparency has measurable rendering cost, so clear
    // it explicitly when opacity is at (or above) 1 to avoid a stale `true`
    // bleeding in from a prior opacity setting that has since been reset.
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
    // Why: xterm's macOptionIsMeta only flips on the 'true' mode. 'left' and
    // 'right' are handled in the keydown policy (terminal-shortcut-policy),
    // which needs Option to stay composable at the xterm level for the
    // non-Meta side. Treating only 'true' as Meta here matches the pre-
    // detection behavior; the detection layer simply decides *what* value
    // `effectiveMacOptionAsAlt` carries.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    pane.terminal.options.lineHeight = normalizeTerminalLineHeight(settings.terminalLineHeight)
    // Why call unconditionally: the per-pane helper is a no-op when the
    // current addon state already matches, so passing the resolved value on
    // every appearance apply keeps newly-created panes in sync without a
    // separate hook and lets live toggles (settings change, font swap)
    // land immediately.
    manager.setPaneLigaturesEnabled(pane.id, ligaturesEnabled)
    try {
      const state = captureScrollState(pane.terminal)
      safeFit(pane)
      restoreScrollState(pane.terminal, state)
    } catch {
      /* ignore */
    }
    const transport = paneTransports.get(pane.id)
    // Why: skip PTY resize when a mobile-fit override is active — the PTY
    // is already at the correct phone dimensions and must not be resized
    // back to desktop dimensions by an appearance change.
    const appearancePtyId = transport?.getPtyId()
    if (transport?.isConnected() && (!appearancePtyId || !getFitOverrideForPty(appearancePtyId))) {
      transport.resize(pane.terminal.cols, pane.terminal.rows)
      maybePushMode2031Flip(pane.id, appearance.mode, transport, paneMode2031, paneLastThemeMode)
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
