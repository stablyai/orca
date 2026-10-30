import type * as Monaco from 'monaco-editor'
import type { PluginThemeTokenColorRule } from '../../../shared/plugins/artifacts/plugin-theme-artifact'

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

function selectors(rule: PluginThemeTokenColorRule): string[] {
  const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope]
  // Why skip descendant selectors (`a b`): Monaco tokens carry no scope stack to match them.
  return scopes
    .flatMap((scope) => scope.split(','))
    .map((selector) => selector.trim())
    .filter((selector) => selector && !/\s/.test(selector))
}

/** TextMate-style match: the longest selector that is a dot-prefix of `scope`, later rules
 *  winning ties, resolved per setting as VS Code does. */
function resolveScope(rules: readonly PluginThemeTokenColorRule[], scope: string): Resolved {
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
  tokenColors: readonly PluginThemeTokenColorRule[],
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

/** Monaco token rules from a theme's `tokenColors`; `color` returns an opaque `#rrggbb` or null
 *  to drop a foreground (unparseable or unreadable on the editor background). */
export function pluginMonacoTokenRules(
  tokenColors: readonly PluginThemeTokenColorRule[],
  color: (value: string) => string | null
): Monaco.editor.ITokenThemeRule[] {
  // Why the selectors as tokens too: vendored TextMate grammars hand Monaco raw scopes, which
  // Monaco's dotted-prefix rule match resolves exactly like TextMate's.
  const rawScopes = [...new Set(tokenColors.flatMap(selectors))]
  const monacoTokens = [
    ...new Set([...Object.keys(MONACO_TOKEN_SCOPES), ...BUILT_IN_SPECIFIC_TOKENS])
  ]
  return [
    ...rawScopes.flatMap((scope) => rule(scope, [scope], tokenColors, color)),
    ...monacoTokens.flatMap((token) => rule(token, scopeChain(token), tokenColors, color))
  ]
}
