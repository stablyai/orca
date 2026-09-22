import { describe, expect, it, vi } from 'vitest'
import {
  GDRESOURCE_LANGUAGE_ID,
  GDRESOURCE_TEXTMATE_SCOPE,
  GDSCRIPT_LANGUAGE_ID,
  GDSCRIPT_TEXTMATE_SCOPE,
  loadGodotTextMateGrammar,
  registerGdscriptLanguage
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

describe('registerGdscriptLanguage', () => {
  it('registers GDScript and Godot resource languages with TextMate token providers', () => {
    const monaco = createMonacoMock()

    registerGdscriptLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: GDSCRIPT_LANGUAGE_ID, extensions: ['.gd'] })
    )
    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: GDRESOURCE_LANGUAGE_ID,
        extensions: ['.tscn', '.tres', '.escn', '.godot']
      })
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledTimes(2)
  })
})

describe('loadGodotTextMateGrammar', () => {
  it('loads the vendored grammars for both Godot scopes', async () => {
    await expect(loadGodotTextMateGrammar(GDSCRIPT_TEXTMATE_SCOPE)).resolves.toMatchObject({
      name: 'GDScript',
      scopeName: GDSCRIPT_TEXTMATE_SCOPE
    })
    await expect(loadGodotTextMateGrammar(GDRESOURCE_TEXTMATE_SCOPE)).resolves.toMatchObject({
      scopeName: GDRESOURCE_TEXTMATE_SCOPE
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadGodotTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
