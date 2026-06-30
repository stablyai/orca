import { describe, expect, it, vi } from 'vitest'
import { registerVueLanguage, vueLanguageConfiguration } from './register-vue'

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

describe('registerVueLanguage', () => {
  it('registers the vue language metadata and configuration without a tokenizer override', () => {
    const monacoMock = createMonacoMock()

    registerVueLanguage(monacoMock as never)
    registerVueLanguage(monacoMock as never)

    expect(monacoMock.languages.register).toHaveBeenCalledTimes(1)
    expect(monacoMock.languages.register).toHaveBeenCalledWith({
      id: 'vue',
      extensions: ['.vue'],
      aliases: ['Vue']
    })
    expect(monacoMock.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledTimes(2)
    expect(monacoMock.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      'vue',
      vueLanguageConfiguration
    )
  })
})
