import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const ORCA_MONACO_LIGHT_THEME = 'orca-vs'
export const ORCA_MONACO_DARK_THEME = 'orca-vs-dark'
export const ORCA_MONACO_LIGHT_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '008000', fontStyle: 'italic' },
  { token: 'string', foreground: 'a31515' },
  { token: 'constant.numeric', foreground: '098658' },
  { token: 'constant.language', foreground: '0000ff' },
  { token: 'constant.character.escape', foreground: 'ee0000' },
  { token: 'constant.other', foreground: '0070c1' },
  { token: 'keyword', foreground: '0000ff' },
  { token: 'keyword.operator', foreground: '000000' },
  { token: 'storage', foreground: '0000ff' },
  { token: 'entity.name.function', foreground: '795e26' },
  { token: 'entity.name.type', foreground: '267f99' },
  { token: 'entity.name.class', foreground: '267f99' },
  { token: 'entity.name.tag', foreground: '800000' },
  { token: 'entity.name.namespace', foreground: '267f99' },
  { token: 'entity.name.section', foreground: '795e26' },
  { token: 'entity.other.attribute-name', foreground: 'ff0000' },
  { token: 'support.class', foreground: '267f99' },
  { token: 'support.function', foreground: '795e26' },
  { token: 'support.type', foreground: '267f99' },
  { token: 'support.constant', foreground: '0070c1' },
  { token: 'support.variable', foreground: '001080' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.other.property', foreground: '001080' },
  { token: 'variable.language', foreground: '0000ff' },
  { token: 'variable.parameter', foreground: '001080' },
  { token: 'string.regexp', foreground: '811f3f' },
  { token: 'punctuation.definition.string', foreground: 'a31515' },
  { token: 'punctuation.definition.comment', foreground: '008000' },
  { token: 'punctuation.definition.template-expression', foreground: '0000ff' },
  { token: 'markup.heading', foreground: '0000ff', fontStyle: 'bold' },
  { token: 'markup.bold', fontStyle: 'bold' },
  { token: 'markup.italic', fontStyle: 'italic' },
  { token: 'markup.inline.raw', foreground: 'a31515' },
  { token: 'markup.fenced_code', foreground: 'a31515' },
  { token: 'markup.underline.link', foreground: '0000ff', fontStyle: 'underline' },
  { token: 'markup.quote', foreground: '008000' },
  { token: 'markup.inserted', foreground: '098658' },
  { token: 'markup.deleted', foreground: 'a31515' },
  { token: 'markup.changed', foreground: '795e26' },
  { token: 'invalid', foreground: 'cd3131' }
]

export const ORCA_MONACO_DARK_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'constant.numeric', foreground: 'b5cea8' },
  { token: 'constant.language', foreground: '569cd6' },
  { token: 'constant.character.escape', foreground: 'd7ba7d' },
  { token: 'constant.other', foreground: '4fc1ff' },
  { token: 'keyword', foreground: '569cd6' },
  { token: 'keyword.operator', foreground: 'd4d4d4' },
  { token: 'storage', foreground: '569cd6' },
  { token: 'entity.name.function', foreground: 'dcdcaa' },
  { token: 'entity.name.type', foreground: '4ec9b0' },
  { token: 'entity.name.class', foreground: '4ec9b0' },
  { token: 'entity.name.tag', foreground: '569cd6' },
  { token: 'entity.name.namespace', foreground: '4ec9b0' },
  { token: 'entity.name.section', foreground: 'dcdcaa' },
  { token: 'entity.other.attribute-name', foreground: '9cdcfe' },
  { token: 'support.class', foreground: '4ec9b0' },
  { token: 'support.function', foreground: 'dcdcaa' },
  { token: 'support.type', foreground: '4ec9b0' },
  { token: 'support.constant', foreground: '4fc1ff' },
  { token: 'support.variable', foreground: '9cdcfe' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'variable.other.property', foreground: '9cdcfe' },
  { token: 'variable.language', foreground: '569cd6' },
  { token: 'variable.parameter', foreground: '9cdcfe' },
  { token: 'string.regexp', foreground: 'd16969' },
  { token: 'punctuation.definition.string', foreground: 'ce9178' },
  { token: 'punctuation.definition.comment', foreground: '6a9955' },
  { token: 'punctuation.definition.template-expression', foreground: '569cd6' },
  { token: 'markup.heading', foreground: '569cd6', fontStyle: 'bold' },
  { token: 'markup.bold', fontStyle: 'bold' },
  { token: 'markup.italic', fontStyle: 'italic' },
  { token: 'markup.inline.raw', foreground: 'ce9178' },
  { token: 'markup.fenced_code', foreground: 'ce9178' },
  { token: 'markup.underline.link', foreground: '3794ff', fontStyle: 'underline' },
  { token: 'markup.quote', foreground: '6a9955' },
  { token: 'markup.inserted', foreground: 'b5cea8' },
  { token: 'markup.deleted', foreground: 'd16969' },
  { token: 'markup.changed', foreground: 'dcdcaa' },
  { token: 'invalid', foreground: 'f44747' }
]

export function registerOrcaMonacoTheme(monaco: MonacoModule): void {
  monaco.editor.defineTheme(ORCA_MONACO_LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: ORCA_MONACO_LIGHT_THEME_RULES,
    colors: {}
  })

  monaco.editor.defineTheme(ORCA_MONACO_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: ORCA_MONACO_DARK_THEME_RULES,
    colors: {}
  })
}
