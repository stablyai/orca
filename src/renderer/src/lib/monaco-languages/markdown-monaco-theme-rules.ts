import type * as Monaco from 'monaco-editor'
import { MIN_SYNTAX_CONTRAST } from '../plugin-monaco-theme'
import { MARKDOWN_TOKEN_PREFIX, markdownTokenRules } from '../plugin-monaco-token-rules'
import { contrastRatio, type Rgba } from '../plugin-theme-tokens'

type ThemeRule = Monaco.editor.ITokenThemeRule
type ThemeBase = 'light' | 'dark'

/** Dark+ / Light+ markdown rules, the colors the stock Dark and Light editors show. */
export type BuiltInMarkdownRules = { rules: ThemeRule[]; plainForeground: string }

const loaded: Partial<Record<ThemeBase, Promise<BuiltInMarkdownRules>>> = {}

/** `#rrggbb` for an opaque `#rrggbb` / `#rrggbbff`, as Monaco reads a rule color; else null. */
function opaqueHex(value: string | undefined): string | null {
  const match = /^#([0-9a-f]{6})(?:ff)?$/i.exec(value ?? '')
  return match ? `#${match[1].toLowerCase()}` : null
}

function rgb(hex: string): Rgba {
  const channel = (index: number): number => Number.parseInt(hex.slice(index, index + 2), 16)
  return [channel(1), channel(3), channel(5), 1]
}

export function loadBuiltInMarkdownRules(base: ThemeBase): Promise<BuiltInMarkdownRules> {
  loaded[base] ??= (
    base === 'dark' ? import('shiki/themes/dark-plus.mjs') : import('shiki/themes/light-plus.mjs')
  ).then(({ default: theme }) => ({
    rules: markdownTokenRules(theme.tokenColors ?? [], (value) => value),
    plainForeground: opaqueHex(theme.colors?.['editor.foreground']) ?? ''
  }))
  loaded[base].catch(() => {
    // Why: a failed chunk load must not stick; the next theme definition retries.
    delete loaded[base]
  })
  return loaded[base]
}

/** Whether `token` or a dotted prefix of it is in `tokens`, as Monaco matches a rule. */
export function matchesPrefix(tokens: ReadonlySet<string>, token: string): boolean {
  for (let end = token.length; end > 0; end = token.lastIndexOf('.', end - 1)) {
    if (tokens.has(token.slice(0, end))) {
      return true
    }
  }
  return false
}

/** A plugin theme plus the built-in markdown colors wherever its own `md.` rules leave a token unset. */
export function withBuiltInMarkdownRules(
  data: Monaco.editor.IStandaloneThemeData,
  builtIn: BuiltInMarkdownRules
): Monaco.editor.IStandaloneThemeData {
  const own = data.rules.filter((rule) => rule.token.startsWith(MARKDOWN_TOKEN_PREFIX))
  const ownForeground = new Set(own.filter((rule) => rule.foreground).map((rule) => rule.token))
  const ownFontStyle = new Set(
    own.filter((rule) => rule.fontStyle !== undefined).map((rule) => rule.token)
  )
  const themeForeground = opaqueHex(data.colors['editor.foreground'])
  const background = opaqueHex(data.colors['editor.background'])
  // Why: the built-in colors were picked for Monaco's own background, not the theme's.
  const readable = (color: string | undefined): string | undefined => {
    const value = opaqueHex(color)
    if (!value) {
      return undefined
    }
    if (value === builtIn.plainForeground && themeForeground) {
      // Dark+ / Light+ write plain text (embedded code, operators) in their own foreground.
      return themeForeground
    }
    return !background || contrastRatio(rgb(value), rgb(background)) >= MIN_SYNTAX_CONTRAST
      ? value
      : undefined
  }
  const fallback = builtIn.rules.flatMap((rule): ThemeRule[] => {
    const foreground = matchesPrefix(ownForeground, rule.token)
      ? undefined
      : readable(rule.foreground)
    const fontStyle = matchesPrefix(ownFontStyle, rule.token) ? undefined : rule.fontStyle
    if (foreground === undefined && fontStyle === undefined) {
      return []
    }
    return [
      {
        token: rule.token,
        ...(foreground !== undefined ? { foreground } : {}),
        ...(fontStyle !== undefined ? { fontStyle } : {})
      }
    ]
  })
  return { ...data, rules: [...fallback, ...data.rules] }
}

/** The theme data to define: a plugin theme plus the built-in markdown colors for its base. */
export async function monacoThemeDataWithMarkdown(
  data: Monaco.editor.IStandaloneThemeData
): Promise<Monaco.editor.IStandaloneThemeData> {
  const base: ThemeBase = data.base === 'vs' || data.base === 'hc-light' ? 'light' : 'dark'
  try {
    return withBuiltInMarkdownRules(data, await loadBuiltInMarkdownRules(base))
  } catch (error) {
    console.warn('[markdown] built-in markdown colors failed to load; markdown stays plain', error)
    return data
  }
}
