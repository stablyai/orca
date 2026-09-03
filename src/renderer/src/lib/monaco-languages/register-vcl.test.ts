import { describe, expect, it, vi } from 'vitest'
import {
  VCL_LANGUAGE_ID,
  VCL_TEXTMATE_SCOPE,
  loadVclTextMateGrammar,
  vclLanguageConfiguration,
  registerVclLanguage
} from './register-vcl'

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

describe('registerVclLanguage', () => {
  it('maps the VCL extension to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    registerVclLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: VCL_LANGUAGE_ID,
      extensions: ['.vcl'],
      aliases: ['VCL', 'vcl', 'Varnish Configuration Language']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      VCL_LANGUAGE_ID,
      vclLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      VCL_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('loadVclTextMateGrammar', () => {
  it('loads the vendored VCL TextMate grammar for the VCL scope', async () => {
    const grammar = await loadVclTextMateGrammar(VCL_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'Varnish Configuration Language',
      scopeName: VCL_TEXTMATE_SCOPE
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadVclTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
