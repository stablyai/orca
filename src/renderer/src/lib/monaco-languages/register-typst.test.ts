import { describe, expect, it, vi } from 'vitest'
import {
  TYPST_LANGUAGE_ID,
  TYPST_TEXTMATE_SCOPE,
  loadTypstTextMateGrammar,
  registerTypstLanguage,
  typstLanguageConfiguration
} from './register-typst'

function createMonacoMock(languages: { id: string }[] = []) {
  return {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerTypstLanguage', () => {
  it('registers Typst with its extension, TextMate scope, and editor configuration', () => {
    const monaco = createMonacoMock()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock exercises only the four languages.* calls this registration touches; the full Monaco module type cannot be satisfied structurally.
    registerTypstLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: TYPST_LANGUAGE_ID,
      extensions: ['.typ'],
      aliases: ['Typst', 'typst']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      TYPST_LANGUAGE_ID,
      typstLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      TYPST_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })

  it('does not register Typst twice', () => {
    const monaco = createMonacoMock([{ id: TYPST_LANGUAGE_ID }])

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same mock shape as the registration test above; only the languages.* surface is driven.
    registerTypstLanguage(monaco as never)

    expect(monaco.languages.register).not.toHaveBeenCalled()
    expect(monaco.languages.setLanguageConfiguration).not.toHaveBeenCalled()
    expect(monaco.languages.registerTokensProviderFactory).not.toHaveBeenCalled()
  })
})

describe('loadTypstTextMateGrammar', () => {
  it('lazily loads the vendored Typst grammar for the Typst scope', async () => {
    const grammar = await loadTypstTextMateGrammar(TYPST_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'typst',
      scopeName: TYPST_TEXTMATE_SCOPE
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadTypstTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
