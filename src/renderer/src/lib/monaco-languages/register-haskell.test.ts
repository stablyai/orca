import { describe, expect, it, vi } from 'vitest'
import { loadHaskellTextMateGrammar, registerHaskellLanguage } from './register-haskell'

describe('registerHaskellLanguage', () => {
  it('registers a lazy tokenizer once for Haskell source and signature files', () => {
    const languages: { id: string }[] = []
    const monaco = {
      editor: { defineTheme: vi.fn() },
      languages: {
        getLanguages: () => languages,
        register: vi.fn((language: { id: string }) => languages.push(language)),
        setLanguageConfiguration: vi.fn(),
        registerTokensProviderFactory: vi.fn()
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only uses the four mocked language methods.
    registerHaskellLanguage(monaco as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only uses the four mocked language methods.
    registerHaskellLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledExactlyOnceWith({
      id: 'haskell',
      extensions: ['.hs', '.hsig', '.hs-boot'],
      aliases: ['Haskell', 'haskell']
    })
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledExactlyOnceWith(
      'haskell',
      expect.objectContaining({ create: expect.any(Function) })
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith('vs-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [{ token: 'entity.name.function.haskell', foreground: 'DCDCAA' }],
      colors: {}
    })
  })

  it('ignores unrelated grammar scopes', async () => {
    await expect(loadHaskellTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
