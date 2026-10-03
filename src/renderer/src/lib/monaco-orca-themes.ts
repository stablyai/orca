import type * as Monaco from 'monaco-editor'

const ORCA_LIGHT_THEME = 'orca-light'
const ORCA_DARK_THEME = 'orca-dark'

type SemanticPalette = {
  variable: string
  method: string
  type: string
  enumMember: string
  baseForeground: string
}

// Why: Monaco token themes take literal hex, not CSS variables; values are VS Code Light+/Dark+.
const LIGHT_PALETTE: SemanticPalette = {
  variable: '001080',
  method: '795E26',
  type: '267F99',
  enumMember: '0070C1',
  baseForeground: '000000'
}
const DARK_PALETTE: SemanticPalette = {
  variable: '9CDCFE',
  method: 'DCDCAA',
  type: '4EC9B0',
  enumMember: '4FC1FF',
  baseForeground: 'D4D4D4'
}

const SEMANTIC_RULE_COLORS = {
  parameter: 'variable',
  property: 'variable',
  method: 'method',
  function: 'method',
  class: 'type',
  namespace: 'type',
  enumMember: 'enumMember'
} as const satisfies Record<string, keyof SemanticPalette>

// Why: built-in `variable`/`type`/`keyword` rules already color those; overriding them would recolor every Monarch language.
const BUILT_IN_RULED_SEMANTIC_TYPES = ['variable', 'type', 'keyword']

// Why: an unruled semantic type paints the root foreground over Monarch's color, so only these are kept.
export const THEMED_SEMANTIC_TOKEN_TYPES: readonly string[] = [
  ...BUILT_IN_RULED_SEMANTIC_TYPES,
  ...Object.keys(SEMANTIC_RULE_COLORS)
]

function semanticRules(palette: SemanticPalette): Monaco.editor.ITokenThemeRule[] {
  return [
    ...Object.entries(SEMANTIC_RULE_COLORS).map(([token, color]) => ({
      token,
      foreground: palette[color]
    })),
    // Why: Ruby Monarch names @ivar/@@cvar tokens `namespace.*`; keep them variable-colored.
    { token: 'namespace.instance.identifier', foreground: palette.variable },
    { token: 'namespace.class.identifier', foreground: palette.variable },
    // Why: C# Monarch names preprocessor lines `namespace.cpp`; keep the base theme's unruled foreground.
    { token: 'namespace.cpp', foreground: palette.baseForeground }
  ]
}

type RubySyntaxPalette = {
  keyword: string
  number: string
  regexp: string
  // Why: mirrors of the built-in vs / vs-dark rules, so a sigil or delimiter matches its token.
  builtInString: string
  builtInComment: string
  builtInConstant: string
  builtInVariable: string
}

const LIGHT_RUBY_SYNTAX_PALETTE: RubySyntaxPalette = {
  keyword: '0000FF',
  number: '098658',
  regexp: '811F3F',
  builtInString: 'A31515',
  builtInComment: '008000',
  builtInConstant: 'DD0000',
  builtInVariable: '001188'
}
const DARK_RUBY_SYNTAX_PALETTE: RubySyntaxPalette = {
  keyword: '569CD6',
  number: 'B5CEA8',
  regexp: 'D16969',
  builtInString: 'CE9178',
  builtInComment: '608B4E',
  builtInConstant: '569CD6',
  builtInVariable: '74B0DF'
}

// Why: Ruby TextMate scopes the built-in themes leave unruled or share with another token kind.
const RUBY_TEXTMATE_SCOPE_COLORS = {
  'entity.name.function.ruby': 'method',
  'support.function.kernel.ruby': 'method',
  'entity.name.type.class.ruby': 'type',
  'entity.name.type.module.ruby': 'type',
  'entity.other.inherited-class.ruby': 'type',
  'support.class.ruby': 'type',
  'variable.other.constant.ruby': 'enumMember',
  'variable.language.self.ruby': 'keyword',
  'punctuation.section.embedded.begin.ruby': 'keyword',
  'punctuation.section.embedded.end.ruby': 'keyword',
  'constant.numeric.ruby': 'number',
  'string.regexp.interpolated.ruby': 'regexp',
  'string.regexp.group.ruby': 'regexp',
  'string.regexp.character-class.ruby': 'regexp',
  'string.regexp.arbitrary-repetition.ruby': 'regexp',
  'punctuation.section.regexp.ruby': 'regexp',
  'punctuation.section.regexp.begin.ruby': 'regexp',
  'punctuation.section.regexp.end.ruby': 'regexp',
  'keyword.operator.assignment.ruby': 'baseForeground',
  'keyword.operator.assignment.augmented.ruby': 'baseForeground',
  'keyword.operator.arithmetic.ruby': 'baseForeground',
  'keyword.operator.comparison.ruby': 'baseForeground',
  'keyword.operator.logical.ruby': 'baseForeground',
  'keyword.operator.other.ruby': 'baseForeground',
  'punctuation.definition.string.begin.ruby': 'builtInString',
  'punctuation.definition.string.end.ruby': 'builtInString',
  'punctuation.definition.comment.ruby': 'builtInComment',
  'punctuation.definition.comment.begin.ruby': 'builtInComment',
  'punctuation.definition.comment.end.ruby': 'builtInComment',
  'punctuation.definition.constant.ruby': 'builtInConstant',
  'punctuation.definition.constant.hashkey.ruby': 'builtInConstant',
  'punctuation.definition.symbol.begin.ruby': 'builtInConstant',
  'punctuation.definition.symbol.end.ruby': 'builtInConstant',
  'punctuation.definition.variable.ruby': 'builtInVariable'
} as const satisfies Record<`${string}.ruby`, keyof SemanticPalette | keyof RubySyntaxPalette>

function rubyTextMateRules(
  palette: SemanticPalette & RubySyntaxPalette
): Monaco.editor.ITokenThemeRule[] {
  return Object.entries(RUBY_TEXTMATE_SCOPE_COLORS).map(([token, color]) => ({
    token,
    foreground: palette[color]
  }))
}

export function orcaMonacoTheme(isDark: boolean): string {
  return isDark ? ORCA_DARK_THEME : ORCA_LIGHT_THEME
}

export function defineOrcaMonacoThemes(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(ORCA_LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      ...semanticRules(LIGHT_PALETTE),
      ...rubyTextMateRules({ ...LIGHT_PALETTE, ...LIGHT_RUBY_SYNTAX_PALETTE })
    ],
    colors: {}
  })
  monaco.editor.defineTheme(ORCA_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      ...semanticRules(DARK_PALETTE),
      ...rubyTextMateRules({ ...DARK_PALETTE, ...DARK_RUBY_SYNTAX_PALETTE })
    ],
    colors: {}
  })
}
