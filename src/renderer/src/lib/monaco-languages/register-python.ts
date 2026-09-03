import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco
type MonarchLanguage = Monaco.languages.IMonarchLanguage
type MonarchRule = Monaco.languages.IMonarchLanguageRule
type MonarchTokenizer = Record<string, MonarchRule[]>

export const PYTHON_LANGUAGE_ID = 'python'
export const TRIPLE_DOUBLE_QUOTED_F_STRING_STATE = 'fTripleDblStringBody'
export const TRIPLE_SINGLE_QUOTED_F_STRING_STATE = 'fTripleStringBody'

// Monaco's `strings` state matches `f"{1,3}` — a quantifier on the quote, not on
// `f"` — so `f"""` lands in the single-line `fDblStringBody`. That state ends the
// line with `@popall`, spilling the f-string body into `root`; the closing `"""`
// is then read as an *opening* docstring and every later line tokenizes as string.
// These states keep a triple-quoted f-string open until its real terminator.
const tripleDoubleQuotedFStringRules: MonarchRule[] = [
  [/"""/, 'string.escape', '@popall'],
  [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
  [/\\./, 'string'],
  [/[^\\"{}]+/, 'string'],
  [/["{}]/, 'string'],
  // Matches the stock string states: a backslash-continuation at end of line.
  [/\\$/, 'string']
]

const tripleSingleQuotedFStringRules: MonarchRule[] = [
  [/'''/, 'string.escape', '@popall'],
  [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
  [/\\./, 'string'],
  [/[^\\'{}]+/, 'string'],
  [/['{}]/, 'string'],
  // Matches the stock string states: a backslash-continuation at end of line.
  [/\\$/, 'string']
]

/**
 * Return a copy of Monaco's stock Python grammar that tokenizes triple-quoted
 * f-strings (`f"""` / `f'''`) as multi-line strings. The stock grammar is left
 * untouched so a second call cannot compound the patch.
 */
export function patchPythonTripleQuotedFStrings(language: MonarchLanguage): MonarchLanguage {
  const tokenizer = language.tokenizer as MonarchTokenizer
  const stockStringRules = tokenizer.strings ?? []

  return {
    ...language,
    tokenizer: {
      ...tokenizer,
      // Ordered before the stock `f'{1,3}` / `f"{1,3}` rules so the triple-quote
      // forms win; the stock rules still own single- and double-quote f-strings.
      strings: [
        [/f"""/, 'string.escape', `@${TRIPLE_DOUBLE_QUOTED_F_STRING_STATE}`],
        [/f'''/, 'string.escape', `@${TRIPLE_SINGLE_QUOTED_F_STRING_STATE}`],
        ...stockStringRules
      ],
      [TRIPLE_DOUBLE_QUOTED_F_STRING_STATE]: tripleDoubleQuotedFStringRules,
      [TRIPLE_SINGLE_QUOTED_F_STRING_STATE]: tripleSingleQuotedFStringRules
    }
  }
}

export function loadPatchedPythonMonarchLanguage(): Promise<MonarchLanguage> {
  return import('monaco-editor/esm/vs/basic-languages/python/python.js').then(({ language }) =>
    patchPythonTripleQuotedFStrings(language)
  )
}

/**
 * Replace Monaco's built-in Python tokenizer factory with the patched grammar.
 * Registering a factory (rather than an eager provider) keeps the grammar
 * lazily loaded, so files that are never Python still pay nothing at startup.
 */
export function registerPythonLanguage(monaco: MonacoModule): void {
  monaco.languages.registerTokensProviderFactory(PYTHON_LANGUAGE_ID, {
    create: () => loadPatchedPythonMonarchLanguage()
  })
}
