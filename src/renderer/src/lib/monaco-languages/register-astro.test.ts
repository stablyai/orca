import { describe, expect, it, vi } from 'vitest'
import { astroLanguageConfiguration, registerAstroLanguage } from './register-astro'

function createMonacoMock() {
  const languages: { id: string }[] = [{ id: 'typescript' }]
  return {
    languages: {
      register: vi.fn((entry: { id: string }) => {
        languages.push({ id: entry.id })
      }),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      getLanguages: vi.fn(() => languages)
    }
  }
}

describe('registerAstroLanguage', () => {
  it('registers the astro language metadata and configuration without a tokenizer override', () => {
    const monacoMock = createMonacoMock()

    registerAstroLanguage(monacoMock as never)
    registerAstroLanguage(monacoMock as never)

    expect(monacoMock.languages.register).toHaveBeenCalledTimes(1)
    expect(monacoMock.languages.register).toHaveBeenCalledWith({
      id: 'astro',
      extensions: ['.astro'],
      aliases: ['Astro']
    })
    expect(monacoMock.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledTimes(2)
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'astro',
      astroLanguageConfiguration
    )
  })
})
