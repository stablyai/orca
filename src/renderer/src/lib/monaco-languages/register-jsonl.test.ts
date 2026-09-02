import { describe, expect, it, vi } from 'vitest'
import {
  JSONL_LANGUAGE_ID,
  jsonlLanguageConfiguration,
  jsonlMonarchLanguage,
  registerJsonlLanguage
} from './register-jsonl'

function createMonacoMock(existingLanguageIds: string[] = []) {
  return {
    languages: {
      getLanguages: vi.fn(() => existingLanguageIds.map((id) => ({ id }))),
      register: vi.fn(),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}

describe('registerJsonlLanguage', () => {
  it('registers the jsonl language with a Monarch tokenizer and .jsonl extension', () => {
    const monaco = createMonacoMock()

    registerJsonlLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: JSONL_LANGUAGE_ID, extensions: ['.jsonl'] })
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      JSONL_LANGUAGE_ID,
      jsonlLanguageConfiguration
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      JSONL_LANGUAGE_ID,
      jsonlMonarchLanguage
    )
  })

  it('does not attach the JSON language service / diagnostics', () => {
    // Why: whole-document JSON validation would flag every record after line one
    // as trailing content. A Monarch tokens provider is presentation-only.
    expect(jsonlMonarchLanguage.tokenizer).toBeDefined()
    expect('json' in jsonlMonarchLanguage).toBe(false)
  })

  it('registers once and is idempotent when the language already exists', () => {
    const monaco = createMonacoMock([JSONL_LANGUAGE_ID])

    registerJsonlLanguage(monaco as never)

    expect(monaco.languages.register).not.toHaveBeenCalled()
    expect(monaco.languages.setMonarchTokensProvider).not.toHaveBeenCalled()
  })
})
