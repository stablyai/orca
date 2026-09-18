import { describe, expect, it, vi } from 'vitest'
import {
  MATLAB_LANGUAGE_ID,
  MATLAB_TEXTMATE_SCOPE,
  loadMatlabTextMateGrammar,
  matlabLanguageConfiguration,
  registerMatlabLanguage
} from './register-matlab'

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

describe('registerMatlabLanguage', () => {
  it('maps .m to the TextMate-backed matlab language', () => {
    const monaco = createMonacoMock()

    registerMatlabLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: MATLAB_LANGUAGE_ID,
      extensions: ['.m'],
      aliases: ['MATLAB', 'matlab']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      MATLAB_LANGUAGE_ID,
      matlabLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      MATLAB_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('loadMatlabTextMateGrammar', () => {
  it('loads the vendored MATLAB TextMate grammar', async () => {
    const grammar = await loadMatlabTextMateGrammar(MATLAB_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      scopeName: MATLAB_TEXTMATE_SCOPE,
      fileTypes: ['m']
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadMatlabTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
