import type { ITheme } from '@xterm/xterm'
import type * as monacoEditor from 'monaco-editor'
import { isTerminalBackgroundLight } from './terminal-title-contrast'

const THEME_NAME_PREFIX = 'orca-terminal-aligned-'

function stripHash(color: string): string {
  return color.startsWith('#') ? color.slice(1) : color
}

/** Approximate token→ANSI-color mapping; there's no semantic link between a 16-color terminal
 *  palette and syntax categories, so this follows the same convention other terminal-theme-to-editor
 *  converters use (comments dim, strings green, keywords/tags red-ish, etc.). */
function buildTokenRules(theme: ITheme): monacoEditor.editor.ITokenThemeRule[] {
  const tokenSources: [string, string | undefined][] = [
    ['comment', theme.brightBlack ?? theme.black],
    ['string', theme.green],
    ['keyword', theme.magenta],
    ['number', theme.yellow],
    ['function', theme.blue],
    ['type', theme.cyan],
    ['tag', theme.red],
    ['delimiter', theme.red]
  ]
  return tokenSources
    .filter(([, color]) => Boolean(color))
    .map(([token, color]) => ({
      token,
      foreground: stripHash(color as string),
      ...(token === 'comment' ? { fontStyle: 'italic' } : {})
    }))
}

function buildEditorColors(theme: ITheme): monacoEditor.editor.IColors {
  const colorSources: [string, string | undefined][] = [
    ['editor.background', theme.background],
    ['editor.foreground', theme.foreground],
    ['editorCursor.foreground', theme.cursor],
    ['editor.selectionBackground', theme.selectionBackground],
    ['editorLineNumber.foreground', theme.brightBlack],
    ['editorLineNumber.activeForeground', theme.foreground]
  ]
  const entries = colorSources.filter((entry): entry is [string, string] => Boolean(entry[1]))
  return Object.fromEntries(entries)
}

/** Defines (redefining on every call, so edited custom theme colors stay current) and returns the
 *  Monaco theme name that mirrors `theme`'s colors. Cheap and synchronous — safe to call from a
 *  render-time memo. */
export function ensureMonacoTerminalAlignedTheme(
  monaco: typeof monacoEditor,
  themeName: string,
  theme: ITheme
): string {
  const monacoThemeName = `${THEME_NAME_PREFIX}${themeName}`
  const base = isTerminalBackgroundLight(theme.background) ? 'vs' : 'vs-dark'
  monaco.editor.defineTheme(monacoThemeName, {
    base,
    inherit: true,
    rules: buildTokenRules(theme),
    colors: buildEditorColors(theme)
  })
  return monacoThemeName
}
