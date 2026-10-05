import { describe, expect, it, vi } from 'vitest'
import {
  GROOVY_LANGUAGE_ID,
  GROOVY_TEXTMATE_SCOPE,
  groovyLanguageConfiguration,
  loadGroovyTextMateGrammar,
  registerGroovyLanguage
} from './register-groovy'

function createMonacoMock(languages: { id: string }[] = []) {
  return {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn((language: { id: string }) => languages.push(language)),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn()
    }
  }
}

describe('registerGroovyLanguage', () => {
  it('maps Groovy extensions and Jenkinsfile to the TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock exercises only the four languages.* calls this registration touches; the full Monaco module type cannot be satisfied structurally.
    registerGroovyLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: GROOVY_LANGUAGE_ID,
      extensions: ['.groovy', '.gvy', '.gy', '.gsh', '.gradle', '.jenkinsfile'],
      filenames: ['Jenkinsfile'],
      aliases: ['Groovy', 'groovy']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      GROOVY_LANGUAGE_ID,
      groovyLanguageConfiguration
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      GROOVY_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })

  it('does not register Groovy twice', () => {
    const monaco = createMonacoMock()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked languages API is used.
    registerGroovyLanguage(monaco as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked languages API is used.
    registerGroovyLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledTimes(1)
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledTimes(1)
  })
})

describe('loadGroovyTextMateGrammar', () => {
  it('loads the vendored Groovy TextMate grammar for the Groovy scope', async () => {
    const grammar = await loadGroovyTextMateGrammar(GROOVY_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'Groovy',
      scopeName: GROOVY_TEXTMATE_SCOPE
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadGroovyTextMateGrammar('source.java')).resolves.toBeNull()
  })
})
