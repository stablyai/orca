import type { LanguageRegistration } from 'shiki'

export async function buildLegacyDiffGrammar(
  name: 'redis' | 'qsharp'
): Promise<LanguageRegistration> {
  const { language } =
    name === 'redis'
      ? await import('monaco-editor/esm/vs/basic-languages/redis/redis.js')
      : await import('monaco-editor/esm/vs/basic-languages/qsharp/qsharp.js')
  const words = (values: readonly string[] | undefined) =>
    `\\b(?:${(values ?? []).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`
  const patterns: LanguageRegistration['patterns'] = [
    {
      name: 'string.quoted.double',
      begin: '"',
      end: '"',
      patterns: [{ name: 'constant.character.escape', match: name === 'redis' ? '""' : '\\\\.' }]
    },
    {
      name: 'constant.numeric',
      match: '\\b(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\\b'
    },
    { name: 'keyword.control', match: (name === 'redis' ? '(?i)' : '') + words(language.keywords) }
  ]
  if (name === 'redis') {
    patterns.unshift({
      name: 'string.quoted.single',
      begin: "'",
      end: "'",
      patterns: [{ match: "''" }]
    })
  } else {
    patterns.unshift({ name: 'comment.line.double-slash', match: '//.*$' })
    patterns.push(
      { name: 'storage.type', match: words(language.typeKeywords) },
      { name: 'constant.language', match: words(language.constants) },
      { name: 'support.function', match: words(language.builtin) },
      { name: 'invalid.illegal', match: words(language.invalidKeywords) }
    )
  }
  return { name, scopeName: `source.${name}`, repository: {}, patterns }
}
