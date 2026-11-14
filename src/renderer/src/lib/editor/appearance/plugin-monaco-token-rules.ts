import type * as Monaco from 'monaco-editor'

/** A VS Code theme's `tokenColors` entry, as plugin themes and Orca's bundled themes write it. */
type TokenColorRule = {
  scope?: string | readonly string[]
  settings: { foreground?: string; fontStyle?: string }
}

// Why: the markdown grammar namespaces its tokens so its rules never recolor another language's.
export const MARKDOWN_TOKEN_PREFIX = 'md.'

// Markdown scopes Dark+ / Light+ leave to the scope they sit in, so themes can style them; each
// falls back to that scope's style (`# Title` text is `entity.name.section` in `markup.heading`).
const MARKDOWN_NESTED_SCOPES: Record<string, readonly string[]> = {
  // Why `.markdown`: fence grammars (ini, LaTeX) emit their own `entity.name.section.*`.
  'entity.name.section.markdown': ['markup.heading'],
  'punctuation.definition.heading.markdown': ['markup.heading'],
  'markup.quote': [],
  'meta.separator': []
}

/** Scopes the markdown tokenizer emits for themes even where the built-in colors leave them plain. */
export const MARKDOWN_THEMABLE_SCOPES = Object.keys(MARKDOWN_NESTED_SCOPES)

// Monaco's languages and the plugin-syntax legend emit Monaco token names, not TextMate scopes, so
// each name reads the scope a VS Code theme would color it by. Longest Monaco prefix wins; a name
// whose scope the theme leaves unset falls back to its parent's (`keyword.md` → `keyword`).
const MONACO_TOKEN_SCOPES: Record<string, string> = {
  comment: 'comment',
  string: 'string',
  'string.escape': 'constant.character.escape',
  'string.key': 'support.type.property-name',
  'string.link': 'markup.underline.link',
  'string.raw': 'markup.inline.raw',
  'keyword.heading': 'markup.heading',
  regexp: 'string.regexp',
  number: 'constant.numeric',
  constant: 'constant',
  keyword: 'keyword',
  'keyword.flow': 'keyword.control',
  'keyword.json': 'constant.language',
  operator: 'keyword.operator',
  delimiter: 'punctuation',
  'delimiter.html': 'punctuation.definition.tag',
  'delimiter.xml': 'punctuation.definition.tag',
  type: 'entity.name.type',
  identifier: 'variable',
  variable: 'variable',
  'variable.parameter': 'variable.parameter',
  'variable.predefined': 'support.variable',
  predefined: 'support.function',
  function: 'entity.name.function',
  tag: 'entity.name.tag',
  metatag: 'entity.name.tag',
  'tag.class': 'entity.other.attribute-name',
  'tag.id': 'entity.other.attribute-name',
  'attribute.name': 'entity.other.attribute-name',
  'attribute.value': 'string',
  'attribute.value.number': 'constant.numeric',
  'attribute.value.hex': 'constant.numeric',
  'attribute.value.unit': 'keyword.other.unit',
  key: 'support.type.property-name',
  annotation: 'meta.decorator',
  invalid: 'invalid',
  emphasis: 'markup.italic',
  strong: 'markup.bold',
  // Monaco's Markdown: headings and list markers are `keyword`, code is `string`/`variable`.
  'keyword.md': 'markup.heading',
  'string.md': 'markup.inline.raw',
  'variable.md': 'markup.inline.raw',
  'comment.md': 'markup.quote'
}

// Why the built-ins' language-specific names too: with `inherit`, a more specific base rule
// (`string.key.json`) would otherwise keep its built-in color under the theme's.
const BUILT_IN_SPECIFIC_TOKENS = [
  'string.key.json',
  'string.value.json',
  'keyword.json',
  'keyword.flow.scss',
  'delimiter.html',
  'delimiter.xml',
  'string.html',
  'string.sql',
  'string.yaml',
  'operator.sql',
  'operator.swift',
  'operator.scss',
  'predefined.sql',
  'metatag.html',
  'metatag.xml',
  'metatag.php',
  'metatag.content.html',
  'tag.class.pug',
  'tag.id.pug',
  'attribute.value.html',
  'attribute.value.xml',
  'attribute.value.number.css',
  'attribute.value.unit.css',
  'attribute.value.hex.css',
  'number.hex'
]

type Resolved = { foreground?: string; fontStyle?: string }

function selectors(rule: TokenColorRule): string[] {
  const scopes = typeof rule.scope === 'string' ? [rule.scope] : (rule.scope ?? [])
  // Why skip descendant selectors (`a b`): Monaco tokens carry no scope stack to match them.
  return scopes
    .flatMap((scope) => scope.split(','))
    .map((selector) => selector.trim())
    .filter((selector) => selector && !/\s/.test(selector))
}

/** TextMate-style match: the longest selector that is a dot-prefix of `scope`, later rules
 *  winning ties, resolved per setting as VS Code does. */
function resolveScope(rules: readonly TokenColorRule[], scope: string): Resolved {
  const best: { foreground?: [number, string]; fontStyle?: [number, string] } = {}
  for (const rule of rules) {
    for (const selector of selectors(rule)) {
      if (scope !== selector && !scope.startsWith(`${selector}.`)) {
        continue
      }
      const score = selector.split('.').length
      for (const key of ['foreground', 'fontStyle'] as const) {
        const value = rule.settings[key]
        if (value !== undefined && score >= (best[key]?.[0] ?? 0)) {
          best[key] = [score, value]
        }
      }
    }
  }
  return { foreground: best.foreground?.[1], fontStyle: best.fontStyle?.[1] }
}

function scopeChain(token: string): string[] {
  const chain: string[] = []
  const parts = token.split('.')
  for (let length = parts.length; length > 0; length -= 1) {
    const scope = MONACO_TOKEN_SCOPES[parts.slice(0, length).join('.')]
    if (scope) {
      chain.push(scope)
    }
  }
  return chain
}

function rule(
  token: string,
  scopes: readonly string[],
  tokenColors: readonly TokenColorRule[],
  color: (value: string) => string | null
): Monaco.editor.ITokenThemeRule[] {
  let foreground: string | undefined
  let fontStyle: string | undefined
  for (const scope of scopes) {
    const resolved = resolveScope(tokenColors, scope)
    foreground ??=
      resolved.foreground === undefined ? undefined : (color(resolved.foreground) ?? undefined)
    fontStyle ??= resolved.fontStyle
  }
  if (foreground === undefined && fontStyle === undefined) {
    return []
  }
  return [
    {
      token,
      ...(foreground !== undefined ? { foreground } : {}),
      ...(fontStyle !== undefined ? { fontStyle } : {})
    }
  ]
}

/** A rule per simple selector in `tokenColors`, for grammars that hand Monaco raw scopes, which
 *  Monaco's dotted-prefix rule match resolves exactly like TextMate's. */
export function scopeTokenRules(
  tokenColors: readonly TokenColorRule[],
  color: (value: string) => string | null
): Monaco.editor.ITokenThemeRule[] {
  return [...new Set(tokenColors.flatMap(selectors))].flatMap((scope) =>
    rule(scope, [scope], tokenColors, color)
  )
}

/** Rules for the markdown grammar's `md.`-prefixed tokens. */
export function markdownTokenRules(
  tokenColors: readonly TokenColorRule[],
  color: (value: string) => string | null,
  scopeRules = scopeTokenRules(tokenColors, color)
): Monaco.editor.ITokenThemeRule[] {
  return [
    ...scopeRules.map((scopeRule) => ({
      ...scopeRule,
      token: `${MARKDOWN_TOKEN_PREFIX}${scopeRule.token}`
    })),
    ...Object.entries(MARKDOWN_NESTED_SCOPES).flatMap(([scope, parents]) =>
      rule(
        `${MARKDOWN_TOKEN_PREFIX}${scope}`,
        [scope, ...parents],
        [...tokenColors, ...nestedSelectorRules(tokenColors, scope, parents)],
        color
      )
    )
  ]
}

const isWithin = (scope: string, selector: string): boolean =>
  scope === selector || scope.startsWith(`${selector}.`)

/** A theme's `parent scope` descendant selectors (`markup.heading entity.name`), as rules for
 *  `scope` itself so they outrank its plain selectors, as the deeper TextMate match would. */
function nestedSelectorRules(
  tokenColors: readonly TokenColorRule[],
  scope: string,
  parents: readonly string[]
): TokenColorRule[] {
  return tokenColors.flatMap((tokenColor) => {
    const scopes =
      typeof tokenColor.scope === 'string' ? [tokenColor.scope] : (tokenColor.scope ?? [])
    const matches = scopes
      .flatMap((selector) => selector.split(','))
      .map((selector) => selector.trim().split(/\s+/))
      .some(
        (parts) =>
          parts.length === 2 &&
          parents.some((parent) => isWithin(parent, parts[0])) &&
          isWithin(scope, parts[1])
      )
    return matches ? [{ scope, settings: tokenColor.settings }] : []
  })
}

/** Monaco token rules from a theme's `tokenColors`; `color` returns an opaque `#rrggbb` or null
 *  to drop a foreground (unparseable or unreadable on the editor background). */
export function pluginMonacoTokenRules(
  tokenColors: readonly TokenColorRule[],
  color: (value: string) => string | null
): Monaco.editor.ITokenThemeRule[] {
  const scopeRules = scopeTokenRules(tokenColors, color)
  const monacoTokens = [
    ...new Set([...Object.keys(MONACO_TOKEN_SCOPES), ...BUILT_IN_SPECIFIC_TOKENS])
  ]
  return [
    ...scopeRules,
    ...markdownTokenRules(tokenColors, color, scopeRules),
    ...monacoTokens.flatMap((token) => rule(token, scopeChain(token), tokenColors, color))
  ]
}
