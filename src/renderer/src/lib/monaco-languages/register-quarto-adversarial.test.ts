import { describe, expect, it } from 'vitest'
import { createMonarchTokenizer, measureNestedDepth } from './monarch-tokenizer-test-harness'
import { EMBED_ENTRY_REST_OF_LINE_BUDGET } from './monarch-embed-entry-budget'
import { QUARTO_LANGUAGE_ID, quartoMonarchLanguage } from './register-quarto'

describe('Quarto adversarial documents', () => {
  it('bounds inherited Markdown script and style embed recursion', () => {
    for (const tag of ['script', 'style']) {
      const tokenizer = createMonarchTokenizer(QUARTO_LANGUAGE_ID, quartoMonarchLanguage)
      const { error, maxNestedDepth } = measureNestedDepth(tokenizer, [
        `<${tag}>x</${tag}>`.repeat(800)
      ])
      expect(error).toBeUndefined()
      expect(maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)
    }
  })
})
