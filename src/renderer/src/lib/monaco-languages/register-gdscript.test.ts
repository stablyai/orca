import { describe, expect, it, vi } from 'vitest'
import {
  GDSCRIPT_LANGUAGE_ID,
  GDSCRIPT_TEXTMATE_SCOPE,
  gdscriptLanguageConfiguration,
  loadGDScriptTextMateGrammar,
  registerGDScriptLanguage
} from './register-gdscript'

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

describe('registerGDScriptLanguage', () => {
  it('maps .gd files to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    registerGDScriptLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: GDSCRIPT_LANGUAGE_ID,
      extensions: ['.gd'],
      aliases: ['GDScript', 'gdscript']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      GDSCRIPT_LANGUAGE_ID,
      gdscriptLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      GDSCRIPT_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('loadGDScriptTextMateGrammar', () => {
  it('loads the vendored GDScript TextMate grammar for the GDScript scope', async () => {
    const grammar = await loadGDScriptTextMateGrammar(GDSCRIPT_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'GDScript',
      scopeName: GDSCRIPT_TEXTMATE_SCOPE,
      fileTypes: ['gd']
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadGDScriptTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
