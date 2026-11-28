import type * as Monaco from 'monaco-editor'
import {
  PANEL_SYNTAX_COLORS,
  panelSyntaxToken,
  type PanelSyntaxColor
} from '../../../../../shared/plugins/frames/plugin-panel-design-tokens'
import type { CodeEditorTheme } from './code-editor-theme'

type ThemeBase = 'light' | 'dark'
type TokenRule = Pick<Monaco.editor.ITokenThemeRule, 'token' | 'foreground'>

// The Monaco token each syntax color reports; theme `tokenColors` reach these through
// pluginMonacoTokenRules (`function` ← `entity.name.function`, `operator` ← `keyword.operator`).
const MONACO_TOKEN: Record<PanelSyntaxColor, string> = {
  comment: 'comment',
  keyword: 'keyword',
  string: 'string',
  number: 'number',
  function: 'function',
  type: 'type',
  variable: 'variable',
  constant: 'constant',
  operator: 'operator',
  tag: 'tag',
  attribute: 'attribute.name'
}

// Monaco 0.55's vs / vs-dark rules for those tokens; `function` and `operator` have none, so
// Monaco paints them as editor text.
const BUILT_IN: Record<ThemeBase, { foreground: string; rules: readonly TokenRule[] }> = {
  light: {
    foreground: '000000',
    rules: [
      { token: 'comment', foreground: '008000' },
      { token: 'keyword', foreground: '0000FF' },
      { token: 'string', foreground: 'A31515' },
      { token: 'number', foreground: '098658' },
      { token: 'type', foreground: '008080' },
      { token: 'variable', foreground: '001188' },
      { token: 'constant', foreground: 'dd0000' },
      { token: 'tag', foreground: '800000' },
      { token: 'attribute.name', foreground: 'FF0000' }
    ]
  },
  dark: {
    foreground: 'D4D4D4',
    rules: [
      { token: 'comment', foreground: '608B4E' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'type', foreground: '3DC9B0' },
      { token: 'variable', foreground: '74B0DF' },
      { token: 'constant', foreground: '569CD6' },
      { token: 'tag', foreground: '569CD6' },
      { token: 'attribute.name', foreground: '9CDCFE' }
    ]
  }
}

/** Monaco's match: the deepest rule that is a dot-prefix of `token`, later rules winning ties. */
function ruleForeground(rules: readonly TokenRule[], token: string): string | undefined {
  let best: { depth: number; foreground: string } | undefined
  for (const rule of rules) {
    if (!rule.foreground || (token !== rule.token && !token.startsWith(`${rule.token}.`))) {
      continue
    }
    const depth = rule.token.split('.').length
    if (!best || depth >= best.depth) {
      best = { depth, foreground: rule.foreground }
    }
  }
  return best?.foreground
}

/** The color the code editor paints each syntax token with, for plugin frames. */
export function codeEditorSyntaxColors(
  theme: CodeEditorTheme,
  appBase: ThemeBase
): Record<PanelSyntaxColor, string> {
  const data = theme.monaco?.data
  const base: ThemeBase = data
    ? data.base === 'vs-dark'
      ? 'dark'
      : 'light'
    : (theme.override?.base ?? appBase)
  const builtIn = BUILT_IN[base]
  const rules = data
    ? data.inherit
      ? [...builtIn.rules, ...data.rules]
      : data.rules
    : builtIn.rules
  // Why editor.foreground: Monaco paints unmatched tokens with it when the theme sets one.
  const foreground = data?.colors['editor.foreground'] ?? builtIn.foreground
  const colors = {} as Record<PanelSyntaxColor, string>
  for (const name of PANEL_SYNTAX_COLORS) {
    const value = ruleForeground(rules, MONACO_TOKEN[name]) ?? foreground
    colors[name] = `#${value.replace(/^#/, '').toLowerCase()}`
  }
  return colors
}

type SyntaxColorsRoot = { style: Pick<CSSStyleDeclaration, 'setProperty'> }

/** Publishes the colors on the root, where plugin frames read their theme tokens. */
export function paintCodeEditorSyntaxColors(
  colors: Record<PanelSyntaxColor, string>,
  root: SyntaxColorsRoot = document.documentElement
): void {
  for (const name of PANEL_SYNTAX_COLORS) {
    root.style.setProperty(panelSyntaxToken(name), colors[name])
  }
}
