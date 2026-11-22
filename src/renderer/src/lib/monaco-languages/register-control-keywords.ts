import type * as Monaco from 'monaco-editor'

type MonacoModule = {
  languages: Pick<typeof Monaco.languages, 'registerTokensProviderFactory'>
}

type MonarchRule = Monaco.languages.IMonarchLanguageRule

// VS Code's TextMate grammar scopes these as `keyword.control`; Monarch otherwise emits plain `keyword`.
const CONTROL_KEYWORDS = [
  'await',
  'break',
  'case',
  'catch',
  'continue',
  'default',
  'do',
  'else',
  'export',
  'finally',
  'for',
  'from',
  'if',
  'import',
  'return',
  'switch',
  'throw',
  'try',
  'while',
  'with',
  'yield'
]

function withControlKeywordCase(rule: MonarchRule): MonarchRule {
  if (!Array.isArray(rule)) {
    return rule
  }
  const [regex, action, ...rest] = rule
  const cases = (action as { cases?: Record<string, unknown> } | undefined)?.cases
  if (!cases || cases['@keywords'] !== 'keyword') {
    return rule
  }
  return [
    regex,
    { cases: { '@controlKeywords': 'keyword.flow', ...cases } },
    ...rest
  ] as MonarchRule
}

/** Emits `keyword.flow` for control keywords, which themes color as `keyword.control`. */
export function withControlKeywords(
  language: Monaco.languages.IMonarchLanguage
): Monaco.languages.IMonarchLanguage {
  const tokenizer = Object.fromEntries(
    Object.entries(language.tokenizer).map(([state, rules]) => [
      state,
      rules.map(withControlKeywordCase)
    ])
  )
  return { ...language, controlKeywords: CONTROL_KEYWORDS, tokenizer }
}

const LANGUAGE_LOADERS = {
  typescript: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
  javascript: () => import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js')
}

export function registerControlKeywordTokenizers(monaco: MonacoModule): void {
  for (const [languageId, load] of Object.entries(LANGUAGE_LOADERS)) {
    monaco.languages.registerTokensProviderFactory(languageId, {
      create: async () => withControlKeywords((await load()).language)
    })
  }
}
