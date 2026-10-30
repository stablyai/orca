// Why these names: Monaco themes style Monaco's own token names (`type`, `number`, `keyword.flow`,
// …) rather than TextMate scopes, so plugin grammars are mapped onto them. Names the built-in
// themes leave plain (`function`, `identifier`, `operator`) or style by parent (`keyword.heading`)
// only take a color from a plugin theme's `tokenColors`.
export const PLUGIN_SYNTAX_TOKEN_TYPES = [
  'comment',
  'string',
  'regexp',
  'number',
  'constant',
  'keyword',
  'keyword.flow',
  'type',
  'variable.parameter',
  'variable.predefined',
  'tag',
  'attribute.name',
  'attribute.value',
  'delimiter',
  'annotation',
  'invalid',
  'emphasis',
  'strong',
  'function',
  'identifier',
  'operator',
  'keyword.heading',
  'string.link',
  'string.raw'
] as const

type PluginSyntaxTokenType = (typeof PLUGIN_SYNTAX_TOKEN_TYPES)[number]

// First matching prefix wins, so more specific scopes come before their parents. Scopes no rule
// matches (meta containers) stay plain.
const SCOPE_RULES: readonly (readonly [string, PluginSyntaxTokenType])[] = [
  ['comment', 'comment'],
  ['string.regexp', 'regexp'],
  ['string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.language', 'keyword'],
  ['constant.character.escape', 'string'],
  ['constant', 'constant'],
  ['support.constant', 'constant'],
  ['keyword.control', 'keyword.flow'],
  ['keyword.operator', 'operator'],
  ['keyword', 'keyword'],
  ['storage', 'keyword'],
  ['variable.language', 'keyword'],
  ['variable.parameter', 'variable.parameter'],
  ['support.variable', 'variable.predefined'],
  ['variable', 'identifier'],
  ['entity.name.function', 'function'],
  ['support.function', 'function'],
  ['entity.name.type', 'type'],
  ['entity.name.class', 'type'],
  ['entity.name.namespace', 'type'],
  ['entity.other.inherited-class', 'type'],
  ['support.type', 'type'],
  ['support.class', 'type'],
  ['entity.name.tag', 'tag'],
  ['entity.other.attribute-name', 'attribute.name'],
  ['meta.attribute-value', 'attribute.value'],
  ['entity.name.decorator', 'annotation'],
  ['meta.decorator', 'annotation'],
  ['markup.heading', 'keyword.heading'],
  ['markup.bold', 'strong'],
  ['markup.italic', 'emphasis'],
  ['markup.raw', 'string.raw'],
  ['markup.inline.raw', 'string.raw'],
  ['markup.underline.link', 'string.link'],
  ['invalid', 'invalid']
]

const TOKEN_TYPE_INDEX = new Map<string, number>(
  PLUGIN_SYNTAX_TOKEN_TYPES.map((type, index) => [type, index])
)

function scopeTokenType(scope: string): PluginSyntaxTokenType | null {
  for (const [prefix, type] of SCOPE_RULES) {
    if (scope === prefix || scope.startsWith(`${prefix}.`)) {
      return type
    }
  }
  return null
}

/**
 * The legend index for a TextMate scope stack: the innermost scope that maps to a styled token.
 * Punctuation is skipped so a comment's `//` or a string's quotes take their enclosing color;
 * punctuation outside any styled scope reads as a delimiter. Null leaves the text plain.
 */
export function pluginSyntaxTokenType(scopes: readonly string[]): number | null {
  let punctuation = false
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index] ?? ''
    if (scope.startsWith('punctuation.')) {
      punctuation = true
      continue
    }
    const type = scopeTokenType(scope)
    if (type) {
      return TOKEN_TYPE_INDEX.get(type) ?? null
    }
  }
  return punctuation ? (TOKEN_TYPE_INDEX.get('delimiter') ?? null) : null
}

/** Monaco's semantic token encoding (delta line, delta start, length, type, modifiers) from the
 *  worker's absolute (line, start, length, legend index) quads. */
export function encodePluginSyntaxTokens(data: Uint32Array): Uint32Array {
  const encoded = new Uint32Array((data.length / 4) * 5)
  let previousLine = 0
  let previousStart = 0
  let out = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const line = data[offset] ?? 0
    const start = data[offset + 1] ?? 0
    encoded[out] = line - previousLine
    encoded[out + 1] = line === previousLine ? start - previousStart : start
    encoded[out + 2] = data[offset + 2] ?? 0
    encoded[out + 3] = data[offset + 3] ?? 0
    out += 5
    previousLine = line
    previousStart = start
  }
  return encoded
}
