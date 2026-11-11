import { describe, expect, it } from 'vitest'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import { JSONL_LANGUAGE_ID, jsonlMonarchLanguage } from './register-jsonl'

function tokenizeJsonl(source: string) {
  return tokenizeMonarchDocument(JSONL_LANGUAGE_ID, jsonlMonarchLanguage, source)
}

describe('jsonl tokenization', () => {
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
})
