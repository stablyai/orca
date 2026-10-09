/**
 * One pipeline from saved settings to the TerminalViewAttributes a terminal paints: theme
 * selection, colour-override spread, opacity, and xterm ThemeService resolution (defaults,
 * cursor blend, 256-entry palette). The renderer publishes these after it paints; main
 * pre-loads them from persisted settings and projects so a hidden PTY's OSC 4/10/11/12 and
 * ?996n replies are byte-identical before and after the renderer's publish.
 */
import type { ITheme } from '@xterm/xterm'
import { HEX_COLOR_RE } from './color-validation'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { TerminalColorSchemeMode } from './terminal-color-scheme-protocol'
import { hexToRgba, parseTerminalCssColor, type ParsedTerminalCssColor } from './terminal-css-color'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  lookupTerminalTheme,
  selectTerminalTheme,
  type TerminalThemeSelection,
  type TerminalThemeSelectionSettings
} from './terminal-theme-selection'
import type { TerminalViewAttributes, TerminalViewRgb } from './terminal-view-attributes'

export type TerminalThemeCompositionSettings = Pick<
  GlobalSettings,
  'terminalColorOverrides' | 'terminalBackgroundOpacity' | 'terminalCursorOpacity'
>

/** Cursor options are optional so a bare selection (the process default) composes too. */
export type TerminalViewCursorSettings = Partial<
  Pick<GlobalSettings, 'terminalCursorStyle' | 'terminalCursorBlink'>
>

export type TerminalViewAttributesSettings = TerminalThemeSelectionSettings &
  Pick<GlobalSettings, 'terminalCustomThemes'> &
  TerminalThemeCompositionSettings &
  TerminalViewCursorSettings

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

// Why extracted: lets the settings preview compose the same theme without depending on PaneManager. Keep pure.
export function composeActiveTerminalTheme(
  baseTheme: ITheme | null,
  settings: TerminalThemeCompositionSettings
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

// ThemeService defaults for the reply-relevant slots (browser/services/
// ThemeService.ts): fg #ffffff, bg #000000, cursor #ffffff.
const DEFAULT_FOREGROUND: ParsedTerminalCssColor = { rgb: [0xff, 0xff, 0xff], alpha: 0xff }
const DEFAULT_BACKGROUND: ParsedTerminalCssColor = { rgb: [0x00, 0x00, 0x00], alpha: 0xff }
const DEFAULT_CURSOR: ParsedTerminalCssColor = { rgb: [0xff, 0xff, 0xff], alpha: 0xff }

// xterm's DEFAULT_ANSI_COLORS first 16 entries (browser/Types.ts).
const DEFAULT_ANSI_16: readonly string[] = [
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec'
]

const THEME_ANSI_KEYS: readonly (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

function parseThemeColor(
  css: string | undefined,
  fallback: ParsedTerminalCssColor
): ParsedTerminalCssColor {
  if (css !== undefined) {
    const parsed = parseTerminalCssColor(css)
    if (parsed) {
      return parsed
    }
  }
  return fallback
}

function buildDefaultAnsiPalette(): TerminalViewRgb[] {
  const palette = DEFAULT_ANSI_16.map((hex) => parseThemeColor(hex, DEFAULT_BACKGROUND).rgb)
  // 16-231: the 6x6x6 color cube, 232-255: greys — same generator as xterm's
  // DEFAULT_ANSI_COLORS IIFE so untouched extended slots reply identically.
  const v = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  for (let i = 0; i < 216; i++) {
    palette.push([v[((i / 36) % 6) | 0], v[((i / 6) % 6) | 0], v[i % 6]])
  }
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10
    palette.push([c, c, c])
  }
  return palette
}

const DEFAULT_ANSI_PALETTE: readonly TerminalViewRgb[] = buildDefaultAnsiPalette()

// Mirror of xterm's color.blend: ThemeService blends the cursor color's
// alpha over the background at theme-set time (terminalCursorOpacity), and
// the OSC 12 reply reports the blended value.
function blendOverBackground(
  background: TerminalViewRgb,
  color: ParsedTerminalCssColor
): TerminalViewRgb {
  if (color.alpha === 0xff) {
    return color.rgb
  }
  const a = color.alpha / 0xff
  return [
    background[0] + Math.round((color.rgb[0] - background[0]) * a),
    background[1] + Math.round((color.rgb[1] - background[1]) * a),
    background[2] + Math.round((color.rgb[2] - background[2]) * a)
  ]
}

/** The reply-relevant slots of a composed ITheme, resolved the way xterm's ThemeService does. */
export function composeTerminalViewAttributes(
  theme: ITheme | null,
  mode: TerminalColorSchemeMode,
  settings: TerminalViewCursorSettings
): TerminalViewAttributes {
  const foreground = parseThemeColor(theme?.foreground, DEFAULT_FOREGROUND)
  const background = parseThemeColor(theme?.background, DEFAULT_BACKGROUND)
  const cursor = parseThemeColor(theme?.cursor, DEFAULT_CURSOR)
  const ansi: TerminalViewRgb[] = THEME_ANSI_KEYS.map((key, i) => {
    const value = theme?.[key]
    return parseThemeColor(typeof value === 'string' ? value : undefined, {
      rgb: DEFAULT_ANSI_PALETTE[i],
      alpha: 0xff
    }).rgb
  })
  for (let i = 16; i < DEFAULT_ANSI_PALETTE.length; i++) {
    const extended = theme?.extendedAnsi?.[i - 16]
    ansi.push(
      parseThemeColor(extended, {
        rgb: DEFAULT_ANSI_PALETTE[i],
        alpha: 0xff
      }).rgb
    )
  }
  return {
    foreground: foreground.rgb,
    background: background.rgb,
    cursor: blendOverBackground(background.rgb, cursor),
    ansi,
    colorSchemeMode: mode,
    // Same resolution as the per-pane option writes in applyTerminalAppearance.
    cursorStyle: settings.terminalCursorStyle ?? 'block',
    cursorBlink: settings.terminalCursorBlink === true
  }
}

/** The selected theme, or the variant's default when the selection no longer resolves. */
export function lookupSelectedTerminalTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>,
  { themeName, useLightVariant }: Pick<TerminalThemeSelection, 'themeName' | 'useLightVariant'>
): ITheme | null {
  return (
    lookupTerminalTheme(settings, themeName) ??
    lookupTerminalTheme(
      settings,
      useLightVariant ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
    )
  )
}

/** The attributes a pane with these settings paints: what the renderer publishes as its global snapshot. */
export function resolveTerminalViewAttributes(
  settings: TerminalViewAttributesSettings,
  systemPrefersDark: boolean
): TerminalViewAttributes {
  const selection = selectTerminalTheme(settings, systemPrefersDark)
  const theme = composeActiveTerminalTheme(
    lookupSelectedTerminalTheme(settings, selection),
    settings
  )
  return composeTerminalViewAttributes(theme, selection.mode, settings)
}

export type TerminalViewAttributesRepo = Pick<
  Repo,
  'id' | 'connectionId' | 'executionHostId' | 'terminalTheme'
>
