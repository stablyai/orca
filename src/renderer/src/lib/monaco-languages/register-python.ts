import type * as Monaco from 'monaco-editor'

type MonarchLanguage = Monaco.languages.IMonarchLanguage

function tripleQuotedFStringRules(
  terminator: RegExp,
  text: RegExp
): Monaco.languages.IMonarchLanguageRule[] {
  return [
    [terminator, 'string.escape', '@popall'],
    [/\{[^}':!=]+/, 'identifier', '@fStringDetail'],
    [/\\./, 'string'],
    [text, 'string'],
    [/./, 'string']
  ]
}

export function patchPythonTripleQuotedFStrings(language: MonarchLanguage): MonarchLanguage {
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      // Triple-quoted f-strings must survive line breaks that end the stock single-line state.
      strings: [
        [/f"""/, 'string.escape', '@fTripleDblStringBody'],
        [/f'''/, 'string.escape', '@fTripleStringBody'],
        ...(language.tokenizer.strings ?? [])
      ],
      fTripleDblStringBody: tripleQuotedFStringRules(/"""/, /[^\\"{}]+/),
      fTripleStringBody: tripleQuotedFStringRules(/'''/, /[^\\'{}]+/)
    }
  }
}

export function registerPythonLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  monaco.languages.registerTokensProviderFactory('python', {
    create: () =>
      import('monaco-editor/esm/vs/basic-languages/python/python.js').then(({ language }) =>
        patchPythonTripleQuotedFStrings(language)
      )
  })
}
