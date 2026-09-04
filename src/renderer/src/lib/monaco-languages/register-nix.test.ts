import { describe, expect, it, vi } from 'vitest'
import {
  NIX_LANGUAGE_ID,
  NIX_TEXTMATE_SCOPE,
  createNixLanguageConfiguration,
  loadNixTextMateGrammar,
  registerNixLanguage
} from './register-nix'

function createMonacoMock() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      registerTokensProviderFactory: vi.fn(),
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 }
    }
  }
}

describe('registerNixLanguage', () => {
  it('maps the Nix extension to the reusable TextMate-backed language registration', () => {
    const monaco = createMonacoMock()

    registerNixLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: NIX_LANGUAGE_ID,
      extensions: ['.nix'],
      aliases: ['Nix', 'nix']
    })
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      NIX_LANGUAGE_ID,
      createNixLanguageConfiguration(monaco as never)
    )
    expect(monaco.languages.registerTokensProviderFactory).toHaveBeenCalledWith(
      NIX_LANGUAGE_ID,
      expect.objectContaining({ create: expect.any(Function) })
    )
  })
})

describe('createNixLanguageConfiguration', () => {
  it('keeps hyphenated Nix identifiers as single words', () => {
    const configuration = createNixLanguageConfiguration(createMonacoMock() as never)

    const words = 'pkgs.home-manager'.match(configuration.wordPattern as RegExp)

    expect(words).toContain('home-manager')
  })

  it('indent-outdents between the Nix indented-string delimiters', () => {
    const configuration = createNixLanguageConfiguration(createMonacoMock() as never)

    const indentedStringRule = configuration.onEnterRules?.find(
      (rule) => rule.beforeText.test("  script = ''") && rule.afterText?.test("'';")
    )

    expect(indentedStringRule?.action.indentAction).toBe(2)
  })

  it('indents after keywords but not after the plain identifier `and`', () => {
    const configuration = createNixLanguageConfiguration(createMonacoMock() as never)

    const matchesRule = (line: string) =>
      configuration.onEnterRules?.some((rule) => !rule.afterText && rule.beforeText.test(line))

    expect(matchesRule('  packages = with')).toBe(true)
    expect(matchesRule('  value = and')).toBe(false)
  })
})

describe('loadNixTextMateGrammar', () => {
  it('loads the vendored Nix TextMate grammar for the Nix scope', async () => {
    const grammar = await loadNixTextMateGrammar(NIX_TEXTMATE_SCOPE)

    expect(grammar).toMatchObject({
      name: 'Nix',
      scopeName: NIX_TEXTMATE_SCOPE,
      fileTypes: ['nix']
    })
  })

  it('ignores unrelated TextMate scopes', async () => {
    await expect(loadNixTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
