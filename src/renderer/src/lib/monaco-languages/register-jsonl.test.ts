import { describe, expect, it } from 'vitest'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import { JSONL_LANGUAGE_ID, jsonlMonarchLanguage } from './register-jsonl'

function tokenizeJsonl(source: string) {
  return tokenizeMonarchDocument(JSONL_LANGUAGE_ID, jsonlMonarchLanguage, source)
}

describe('jsonl tokenization', () => {
  it('colours a property key differently from a string value', () => {
    // Keep the colon lookahead or property keys become string values.
    const [line] = tokenizeJsonl('{"key": "value"}')

    expect(tokenTypeAt(line, 1)).toBe('type.identifier')
    expect(tokenTypeAt(line, 8)).toBe('string')
  })

  // Truncated strings must not carry state into later JSONL records.
  it.each([
    ['mid-string', '{"a": "truncated here'],
    ['mid-escape', '{"a": "truncated\\'],
    ['on a trailing backslash', '{"a": "x\\']
  ])('does not let a record truncated %s poison the next one', (_name, truncated) => {
    const [, second] = tokenizeJsonl(`${truncated}\n{"b": 1}`)

    expect(tokenTypeAt(second, 1)).toBe('type.identifier')
    expect(tokenTypeAt(second, 6)).toBe('number')
  })

  it('marks the unterminated remainder of a truncated record', () => {
    const [first] = tokenizeJsonl('{"a": "truncated here')

    expect(tokenTypeAt(first, 6)).toBe('string.invalid')
  })

  it.each([
    ['escaped quote', '{"m": "he said \\"hi\\""}', 15],
    ['escaped backslash', '{"m": "C:\\\\Users"}', 10],
    ['unicode escape', '{"m": "\\u00e9"}', 7],
    ['newline escape', '{"m": "a\\nb"}', 8]
  ])('still highlights an %s inside a well-formed record', (_name, record, escapeOffset) => {
    // Retain escape fidelity; replacing string state with one regex previously lost these cases.
    const [line] = tokenizeJsonl(record)

    expect(tokenTypeAt(line, escapeOffset)).toBe('string.escape')
  })

  it('flags an invalid escape inside a well-formed record', () => {
    const [line] = tokenizeJsonl('{"m": "a\\qb"}')

    expect(tokenTypeAt(line, 8)).toBe('string.escape.invalid')
  })
})
