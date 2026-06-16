import { describe, expect, it, vi } from 'vitest'
import { registerTextMateLanguage } from './textmate-language-registration'

function createMonacoMock(registeredLanguages: { id: string }[] = []) {
  let tokensProviderFactory: { create: () => unknown } | undefined
  const monaco = {
    languages: {
      getLanguages: vi.fn(() => registeredLanguages),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn(
        (_languageId: string, factory: { create: () => unknown }) => {
          tokensProviderFactory = factory
          return { dispose: vi.fn() }
        }
      )
    }
  }

  return {
    monaco,
    createTokensProvider() {
      if (!tokensProviderFactory) {
        throw new Error('Tokens provider factory was not registered')
      }
      return tokensProviderFactory.create()
    }
  }
}

describe('registerTextMateLanguage', () => {
  it('registers metadata and lazily installs the TextMate tokens provider', async () => {
    const { monaco, createTokensProvider } = createMonacoMock()
    const provider = {
      getInitialState: vi.fn(),
      tokenize: vi.fn()
    }
    const createTextMateTokensProvider = vi.fn(async () => provider)
    const loadProviderModule = vi.fn(async () => ({ createTextMateTokensProvider }))
    const loadGrammar = vi.fn()
    const configuration = { comments: { lineComment: '#' } }

    registerTextMateLanguage(monaco as never, {
      language: {
        id: 'nim',
        extensions: ['.nim'],
        aliases: ['Nim']
      },
      configuration,
      scopeName: 'source.nim',
      loadGrammar,
      loadProviderModule
    })

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: 'nim',
      extensions: ['.nim'],
      aliases: ['Nim']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith('nim', configuration)
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      'nim',
      expect.objectContaining({ create: expect.any(Function) })
    )
    expect(loadProviderModule).not.toHaveBeenCalled()

    const providerPromise = createTokensProvider()

    await expect(providerPromise).resolves.toBe(provider)
    expect(createTextMateTokensProvider).toHaveBeenCalledWith({
      scopeName: 'source.nim',
      loadGrammar
    })
  })

  it('does not register duplicate language ids', () => {
    const { monaco } = createMonacoMock([{ id: 'nim' }])

    registerTextMateLanguage(monaco as never, {
      language: {
        id: 'nim',
        extensions: ['.nim']
      },
      scopeName: 'source.nim',
      loadGrammar: vi.fn()
    })

    expect(monaco.languages.register).not.toHaveBeenCalled()
    expect(monaco.languages.registerTokensProviderFactory).not.toHaveBeenCalled()
  })
})
