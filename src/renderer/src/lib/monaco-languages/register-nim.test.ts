import { describe, expect, it, vi } from 'vitest'
import {
  NIM_LANGUAGE_ID,
  NIM_TEXTMATE_SCOPE,
  loadNimTextMateGrammar,
  nimLanguageConfiguration,
  registerNimLanguage
} from './register-nim'

function createMonacoMock() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerNimLanguage', () => {
  it('maps Nim extensions to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    registerNimLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: NIM_LANGUAGE_ID,
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      NIM_LANGUAGE_ID,
      nimLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      NIM_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('loadNimTextMateGrammar', () => {
  it('loads the vendored Nim TextMate grammar for the Nim scope', async () => {
    const grammar = await loadNimTextMateGrammar(NIM_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'Nim',
      scopeName: NIM_TEXTMATE_SCOPE,
      fileTypes: ['nim', 'nims', 'nimble']
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadNimTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
