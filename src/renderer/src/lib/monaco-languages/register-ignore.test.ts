import { describe, expect, it, vi } from 'vitest'
import {
  IGNORE_LANGUAGE_ID,
  createIgnoreCompletionItems,
  ignoreMonarchLanguage,
  registerIgnoreLanguage
} from './register-ignore'

function createMonacoMock(existingLanguageIds: string[] = []) {
  return {
    Range: class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number
      ) {}
    },
    languages: {
      CompletionItemKind: { Value: 12 },
      getLanguages: vi.fn(() => existingLanguageIds.map((id) => ({ id }))),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      registerCompletionItemProvider: vi.fn()
    }
  }
}

describe('registerIgnoreLanguage', () => {
  it('registers compatible ignore filenames, highlighting, and completion', () => {
    const monaco = createMonacoMock()
    registerIgnoreLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: IGNORE_LANGUAGE_ID,
        filenames: expect.arrayContaining(['.gitignore', '.dockerignore', '.prettierignore'])
      })
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      IGNORE_LANGUAGE_ID,
      ignoreMonarchLanguage
    )
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledOnce()
  })

  it('replaces only the current pattern when completing', () => {
    const monaco = createMonacoMock()
    const items = createIgnoreCompletionItems(
      monaco as never,
      { getWordUntilPosition: () => ({ word: 'node', startColumn: 1, endColumn: 5 }) } as never,
      { lineNumber: 3, column: 5 } as never
    )

    expect(items.some((item) => item.label === 'node_modules/')).toBe(true)
    expect(items[0]?.range).toMatchObject({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 5
    })
  })

  it('does not register twice', () => {
    const monaco = createMonacoMock([IGNORE_LANGUAGE_ID])
    registerIgnoreLanguage(monaco as never)
    expect(monaco.languages.register).not.toHaveBeenCalled()
  })
})
