import type * as Monaco from 'monaco-editor'
import { contrastRatio, type ColorProbe, type Rgba } from './plugin-theme-tokens'

export type PluginMonacoTheme = { name: string; data: Monaco.editor.IStandaloneThemeData }

// The inherited built-in syntax colors are checked against the plugin's editor background.
// Why 3:1 for them: Monaco's own dark comment color is 4.2:1 on its own background.
const MIN_TEXT_CONTRAST = 4.5
const MIN_SYNTAX_CONTRAST = 3
const BUILT_IN_SYNTAX: Record<'light' | 'dark', readonly string[]> = {
  // comment, string, keyword, type, number in vs / vs-dark.
  light: ['#008000', '#a31515', '#0000ff', '#008080', '#098658'],
  dark: ['#608b4e', '#ce9178', '#569cd6', '#3dc9b0', '#b5cea8']
}

function hex([r, g, b, a]: Rgba): string {
  const byte = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`
}

function hashName(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * A Monaco theme from the colors the document is actually painted with (plugin values, built-ins
 * where the plugin is silent), on the built-in light or dark syntax colors. Null when a color can't
 * be resolved or text and syntax colors would lose contrast; the editor then keeps its built-in
 * theme so a plugin theme can never make code unreadable.
 */
export function derivePluginMonacoTheme(input: {
  base: 'light' | 'dark'
  /** A document CSS variable's computed value. */
  read: (token: string) => string
  probe: ColorProbe
}): PluginMonacoTheme | null {
  const color = (token: string): Rgba | null => {
    const value = input.read(token).trim()
    return value ? input.probe(value) : null
  }
  const background = color('--editor-surface') ?? color('--background')
  const foreground = color('--foreground')
  if (!background || background[3] < 1 || !foreground) {
    return null
  }
  if (
    contrastRatio(foreground, background) < MIN_TEXT_CONTRAST ||
    BUILT_IN_SYNTAX[input.base].some(
      (syntax) => contrastRatio(input.probe(syntax) ?? background, background) < MIN_SYNTAX_CONTRAST
    )
  ) {
    return null
  }
  const muted = color('--muted-foreground') ?? foreground
  const accent = color('--accent')
  const ring = color('--ring') ?? foreground
  const popover = color('--popover')
  const border = color('--border')
  const colors: Record<string, string> = {
    'editor.background': hex(background),
    'editor.foreground': hex(foreground),
    'editorGutter.background': hex(background),
    'minimap.background': hex(background),
    'editorLineNumber.foreground': hex(muted),
    'editorLineNumber.activeForeground': hex(foreground),
    'editorCursor.foreground': hex(ring),
    // Why from the ring: a theme's accent is a faint hover tint, too weak to read as a selection.
    'editor.selectionBackground': hex([ring[0], ring[1], ring[2], 0.3]),
    'editor.inactiveSelectionBackground': hex([ring[0], ring[1], ring[2], 0.15])
  }
  if (accent) {
    colors['editor.lineHighlightBackground'] = hex(accent)
  }
  if (popover) {
    colors['editorWidget.background'] = hex(popover)
    colors['editorSuggestWidget.background'] = hex(popover)
  }
  if (border) {
    colors['editorWidget.border'] = hex(border)
  }
  const data: Monaco.editor.IStandaloneThemeData = {
    base: input.base === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors
  }
  return { name: `orca-plugin-${hashName(JSON.stringify(data))}`, data }
}
