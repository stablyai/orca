import { describe, expect, it, vi } from 'vitest'
import {
  formatTokenizedLines,
  tokenizeMonarchDocument,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import {
  JSONL_LANGUAGE_ID,
  jsonlLanguageConfiguration,
  jsonlMonarchLanguage,
  registerJsonlLanguage
} from './register-jsonl'

function tokenizeJsonl(source: string) {
  return tokenizeMonarchDocument(JSONL_LANGUAGE_ID, jsonlMonarchLanguage, source)
}

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

describe('jsonl tokenization', () => {
  it('tokenizes a representative pair of records', () => {
    const fixture = `{"a": 1, "b": "x", "c": true, "d": null}
{"e": [1, -2.5e3], "f": "a\\"b"}`

    expect(formatTokenizedLines(tokenizeJsonl(fixture))).toMatchInlineSnapshot(`
      [
        "{"a": 1, "b": "x", "c": true, "d": null} | 0:delimiter.curly.jsonl@jsonl 1:type.identifier.jsonl@jsonl 4:delimiter.jsonl@jsonl 5:white.jsonl@jsonl 6:number.jsonl@jsonl 7:delimiter.jsonl@jsonl 8:white.jsonl@jsonl 9:type.identifier.jsonl@jsonl 12:delimiter.jsonl@jsonl 13:white.jsonl@jsonl 14:string.jsonl@jsonl 17:delimiter.jsonl@jsonl 18:white.jsonl@jsonl 19:type.identifier.jsonl@jsonl 22:delimiter.jsonl@jsonl 23:white.jsonl@jsonl 24:keyword.jsonl@jsonl 28:delimiter.jsonl@jsonl 29:white.jsonl@jsonl 30:type.identifier.jsonl@jsonl 33:delimiter.jsonl@jsonl 34:white.jsonl@jsonl 35:keyword.jsonl@jsonl 39:delimiter.curly.jsonl@jsonl | embed=none",
        "{"e": [1, -2.5e3], "f": "a\\"b"} | 0:delimiter.curly.jsonl@jsonl 1:type.identifier.jsonl@jsonl 4:delimiter.jsonl@jsonl 5:white.jsonl@jsonl 6:delimiter.square.jsonl@jsonl 7:number.jsonl@jsonl 8:delimiter.jsonl@jsonl 9:white.jsonl@jsonl 10:number.jsonl@jsonl 16:delimiter.square.jsonl@jsonl 17:delimiter.jsonl@jsonl 18:white.jsonl@jsonl 19:type.identifier.jsonl@jsonl 22:delimiter.jsonl@jsonl 23:white.jsonl@jsonl 24:string.jsonl@jsonl 26:string.escape.jsonl@jsonl 28:string.jsonl@jsonl 30:delimiter.curly.jsonl@jsonl | embed=none",
      ]
    `)
  })

  it('colours a property key differently from a string value', () => {
    // The `(?=\s*:)` lookahead is the only thing separating the two; a regression
    // there makes every key look like a value.
    const [line] = tokenizeJsonl('{"key": "value"}')

    expect(tokenTypeAt(line, 1)).toBe('type.identifier')
    expect(tokenTypeAt(line, 8)).toBe('string')
  })

  // KNOWN DEFECT, found by this suite once it started running the real
  // tokenizer. Each JSONL line is an independent JSON value, but the `@string`
  // state survives the line break, so one truncated record (common in logs)
  // renders every record after it as a single string. `it.fails` pins it: this
  // flips to a failure the moment the grammar is fixed, so the fix lands with
  // this expectation inverted rather than silently.
  it.fails('never carries string state across a record boundary', () => {
    const [, second] = tokenizeJsonl('{"a": "unterminated\n{"b": 1}')

    expect(tokenTypeAt(second, 1)).toBe('type.identifier')
    expect(tokenTypeAt(second, 6)).toBe('number')
  })
})
