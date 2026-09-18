import { describe, expect, it, vi } from 'vitest'
import {
  LATEX_LANGUAGE_ID,
  latexLanguageConfiguration,
  latexMonarchLanguage,
  registerLatexLanguage
} from './register-latex'

function createMonacoMock(existing: { id: string }[] = []) {
  return {
    languages: {
      getLanguages: vi.fn(() => existing),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}

describe('registerLatexLanguage', () => {
  it('registers LaTeX extensions with a Monarch tokens provider', () => {
    const monaco = createMonacoMock()

    registerLatexLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: LATEX_LANGUAGE_ID,
      extensions: ['.tex', '.ltx', '.latex', '.sty', '.cls'],
      aliases: ['LaTeX', 'latex', 'TeX', 'tex']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      LATEX_LANGUAGE_ID,
      latexLanguageConfiguration
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      LATEX_LANGUAGE_ID,
      latexMonarchLanguage
    )
  })

  it('is idempotent when the language is already registered', () => {
    const monaco = createMonacoMock([{ id: LATEX_LANGUAGE_ID }])

    registerLatexLanguage(monaco as never)

    expect(monaco.languages.register).not.toHaveBeenCalled()
  })

  it('tokenizes comments and commands in the Monarch root state', () => {
    expect(latexMonarchLanguage.tokenizer.root).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([/%.*$/, 'comment']),
        expect.arrayContaining([expect.any(RegExp), 'keyword'])
      ])
    )
  })
})
