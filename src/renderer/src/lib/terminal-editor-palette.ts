import type { ITheme } from '@xterm/xterm'
import type { editor as monacoEditor } from 'monaco-editor'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isTerminalBackgroundLight, parseCssRgbColor } from './terminal-title-contrast'
import { resolveEffectiveTerminalAppearance } from './terminal-theme'
import type { SurfaceStyleVariables, TerminalSurfaceSettings } from './terminal-surface-colors'

export type TerminalEditorPaletteSettings = TerminalSurfaceSettings &
  Pick<GlobalSettings, 'workspaceChromeAppearanceMode'>

/** Syntax roles shared by Monaco token rules and the hljs `--syntax-*` CSS hooks. */
export type TerminalSyntaxColors = {
  comment: string
  keyword: string
  string: string
  number: string
  function: string
  type: string
  variable: string
  tag: string
  meta: string
  addition: string
  deletion: string
  link: string
}

export type TerminalEditorPalette = {
  isDark: boolean
  /** Opaque `#rrggbb`; Monaco cannot paint a translucent editor surface. */
  background: string
  foreground: string
  cursor: string
  selection: string
  syntax: TerminalSyntaxColors
}

export const TERMINAL_MONACO_THEME_NAME = 'orca-terminal'

/** Matches the --muted-foreground mix in terminal-surface-colors.ts. */
const MUTED_FOREGROUND_MIX_PERCENT = 62
const FALLBACK_BACKGROUND = '#000000'
const FALLBACK_FOREGROUND = '#fafafa'

/** One 0–255 channel as two lowercase hex digits, clamped. */
function channelToHex(channel: number): string {
  return Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, '0')
}

/** Any parseable CSS color to `#rrggbb` (`#rrggbbaa` when translucent); null when it fails to parse. */
export function toHexColor(color: string | undefined): string | null {
  const rgba = parseCssRgbColor(color)
  if (!rgba) {
    return null
  }
  const rgb = `#${channelToHex(rgba.r)}${channelToHex(rgba.g)}${channelToHex(rgba.b)}`
  return rgba.a >= 1 ? rgb : `${rgb}${channelToHex(rgba.a * 255)}`
}

/** Opaque `#rrggbb` of `color-mix(in srgb, fg P%, bg)`; falls back to `fg` when either fails to parse. */
export function mixHexColors(foreground: string, background: string, percent: number): string {
  const fg = parseCssRgbColor(foreground)
  const bg = parseCssRgbColor(background)
  if (!fg || !bg) {
    return foreground
  }
  const weight = Math.min(1, Math.max(0, percent / 100))
  /** Weighted blend of one channel. */
  const mix = (a: number, b: number): number => a * weight + b * (1 - weight)
  return `#${channelToHex(mix(fg.r, bg.r))}${channelToHex(mix(fg.g, bg.g))}${channelToHex(mix(fg.b, bg.b))}`
}

/** First candidate that parses as a color, as hex; otherwise the fallback. */
function pickColor(candidates: (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    const hex = toHexColor(candidate)
    if (hex) {
      return hex
    }
  }
  return fallback
}

/** Editor colors derived from the active terminal theme; null unless the chrome follows the terminal. */
export function resolveTerminalEditorPalette(
  settings: TerminalEditorPaletteSettings | null | undefined,
  systemPrefersDark: boolean
): TerminalEditorPalette | null {
  if (!settings || (settings.workspaceChromeAppearanceMode ?? 'default') !== 'match-terminal') {
    return null
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const theme: ITheme = { ...appearance.theme, ...settings.terminalColorOverrides }
  const rawBackground = theme.background ?? FALLBACK_BACKGROUND
  const background = pickColor([rawBackground], FALLBACK_BACKGROUND).slice(0, 7)
  const foreground = pickColor([theme.foreground], FALLBACK_FOREGROUND).slice(0, 7)
  // Why: the terminal theme's own brightness decides light/dark styling — a light terminal theme under a
  // dark OS setting must still get light syntax and Monaco's `vs` base, not `vs-dark`.
  const isDark = !isTerminalBackgroundLight(rawBackground, {
    backgroundOpacity: settings.terminalBackgroundOpacity ?? undefined,
    appSurface: appearance.mode
  })
  /** ANSI slot color, falling back to the foreground when the theme lacks it. */
  const ansi = (key: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'): string =>
    pickColor([theme[key]], foreground)
  return {
    isDark,
    background,
    foreground,
    cursor: pickColor([theme.cursor], foreground),
    selection: pickColor([theme.selectionBackground], mixHexColors(foreground, background, 22)),
    syntax: {
      // Why: ANSI palettes have no dedicated muted color; mix like --muted-foreground (62%) so comments recede.
      comment: mixHexColors(foreground, background, MUTED_FOREGROUND_MIX_PERCENT),
      keyword: ansi('magenta'),
      string: ansi('green'),
      number: ansi('cyan'),
      function: ansi('blue'),
      type: ansi('yellow'),
      variable: ansi('red'),
      tag: ansi('blue'),
      meta: ansi('cyan'),
      addition: ansi('green'),
      deletion: ansi('red'),
      link: ansi('blue')
    }
  }
}

/** `--syntax-*` hooks the hljs stylesheets read ahead of their GitHub defaults. */
export function buildSyntaxTokenVariables(palette: TerminalEditorPalette): SurfaceStyleVariables {
  const variables: SurfaceStyleVariables = {}
  for (const [role, color] of Object.entries(palette.syntax)) {
    variables[`--syntax-${role}`] = color
  }
  return variables
}

/** `#rrggbb` with the given 0–1 alpha appended as `aa`. */
function alphaHex(color: string, alpha: number): string {
  return `${color.slice(0, 7)}${channelToHex(alpha * 255)}`
}

/** Monaco theme data painting the editor with the terminal palette. */
export function buildMonacoThemeData(
  palette: TerminalEditorPalette
): monacoEditor.IStandaloneThemeData {
  const { background, foreground, syntax } = palette
  /** Foreground mixed into the background at the given percent. */
  const mix = (percent: number): string => mixHexColors(foreground, background, percent)
  /** Monaco token rule; Monaco wants the color without the leading `#`. */
  const rule = (token: string, color: string, fontStyle?: string) => ({
    token,
    foreground: color.slice(1, 7),
    ...(fontStyle ? { fontStyle } : {})
  })
  return {
    base: palette.isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      rule('', foreground),
      rule('comment', syntax.comment, 'italic'),
      rule('keyword', syntax.keyword),
      rule('operator', syntax.keyword),
      rule('string', syntax.string),
      rule('string.value.json', syntax.string),
      rule('attribute.value', syntax.string),
      rule('number', syntax.number),
      rule('constant', syntax.number),
      rule('regexp', syntax.number),
      rule('type', syntax.type),
      rule('predefined', syntax.type),
      rule('attribute.name', syntax.type),
      rule('key', syntax.type),
      rule('string.key.json', syntax.type),
      rule('tag', syntax.tag),
      rule('meta.tag', syntax.tag),
      rule('metatag', syntax.tag),
      rule('variable', syntax.variable),
      rule('annotation', syntax.meta),
      rule('meta', syntax.meta),
      rule('invalid', syntax.deletion),
      rule('emphasis', foreground, 'italic'),
      rule('strong', foreground, 'bold')
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorGutter.background': background,
      'editorLineNumber.foreground': mix(40),
      'editorLineNumber.activeForeground': mix(80),
      'editor.lineHighlightBackground': mix(5),
      'editor.lineHighlightBorder': mix(5),
      'editor.selectionBackground': palette.selection,
      'editor.inactiveSelectionBackground': mix(12),
      'editor.selectionHighlightBackground': mix(14),
      'editor.wordHighlightBackground': mix(12),
      'editor.wordHighlightStrongBackground': mix(18),
      'editor.findMatchBackground': alphaHex(syntax.type, 0.45),
      'editor.findMatchHighlightBackground': alphaHex(syntax.type, 0.25),
      'editorCursor.foreground': palette.cursor,
      'editorWhitespace.foreground': mix(18),
      'editorIndentGuide.background1': mix(10),
      'editorIndentGuide.activeBackground1': mix(25),
      'editorBracketMatch.background': mix(15),
      'editorBracketMatch.border': mix(30),
      'editorWidget.background': mix(5),
      'editorWidget.border': mix(12),
      'editorSuggestWidget.background': mix(5),
      'editorHoverWidget.background': mix(5),
      'input.background': mix(8),
      'input.foreground': foreground,
      'minimap.background': background,
      'scrollbarSlider.background': alphaHex(mix(40), 0.4),
      'scrollbarSlider.hoverBackground': alphaHex(mix(50), 0.5),
      'diffEditor.insertedTextBackground': alphaHex(syntax.addition, 0.2),
      'diffEditor.insertedLineBackground': alphaHex(syntax.addition, 0.1),
      'diffEditor.removedTextBackground': alphaHex(syntax.deletion, 0.2),
      'diffEditor.removedLineBackground': alphaHex(syntax.deletion, 0.1)
    }
  }
}

export type EditorSurfaceAppearance = {
  isDark: boolean
  /** Null when editor panes keep the app theme. */
  palette: TerminalEditorPalette | null
}

/** Light/dark styling for editor panes: the terminal palette when the chrome follows it, else the app theme. */
export function resolveEditorSurfaceAppearance(
  settings: TerminalEditorPaletteSettings | null | undefined,
  systemPrefersDark: boolean
): EditorSurfaceAppearance {
  const palette = resolveTerminalEditorPalette(settings, systemPrefersDark)
  if (palette) {
    return { isDark: palette.isDark, palette }
  }
  const theme = settings?.theme ?? 'system'
  return { isDark: theme === 'dark' || (theme === 'system' && systemPrefersDark), palette: null }
}
