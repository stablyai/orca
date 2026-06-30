import { describe, expect, it, vi } from 'vitest'
import { registerSvelteLanguage, svelteLanguageConfiguration } from './register-svelte'

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

describe('registerSvelteLanguage', () => {
  it('registers the svelte language metadata and configuration without a tokenizer override', () => {
    const monacoMock = createMonacoMock()

    registerSvelteLanguage(monacoMock as never)
    registerSvelteLanguage(monacoMock as never)

    expect(monacoMock.languages.register).toHaveBeenCalledTimes(1)
    expect(monacoMock.languages.register).toHaveBeenCalledWith({
      id: 'svelte',
      extensions: ['.svelte'],
      aliases: ['Svelte']
    })
    expect(monacoMock.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledTimes(2)
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'svelte',
      svelteLanguageConfiguration
    )
  })
})
