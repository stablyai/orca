import { describe, expect, it, vi } from 'vitest'
import { NIM_LANGUAGE_ID, nimLanguageConfiguration, registerNimLanguage } from './register-nim'

function createMonacoMock() {
  const languages: { id: string }[] = []
  return {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn((entry: { id: string }) => {
        languages.push({ id: entry.id })
      }),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerNimLanguage', () => {
  it('registers Nim language metadata and configuration without a tokenizer override', () => {
    const monaco = createMonacoMock()

    registerNimLanguage(monaco as never)
    registerNimLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: NIM_LANGUAGE_ID,
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    })
    expect(monaco.languages.register).toHaveBeenCalledTimes(1)
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      NIM_LANGUAGE_ID,
      nimLanguageConfiguration
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledTimes(2)
    expect(monaco.languages.registerTokensProviderFactory).not.toHaveBeenCalled()
  })
})
