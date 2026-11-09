import { describe, expect, it } from 'vitest'
import { tokenizeMonarchDocument, tokenLanguages } from './monarch-tokenizer-test-harness'
import { astroMonarchLanguage } from './register-astro'

// Use real Monarch tokenization; a valid rule table can still throw on every expression.
function tokenizeAstro(source: string) {
  return tokenizeMonarchDocument('astro', astroMonarchLanguage, source)
}

describe('astro tokenization', () => {
  it('opens a file on an expression without popping a missing embed', () => {
    // An opening expression has no HTML embed to pop yet.
    expect(tokenLanguages(tokenizeAstro('{title}')[0])).toEqual(['astro', 'typescript', 'astro'])
  })
})
