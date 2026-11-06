import { describe, expect, it } from 'vitest'
import { EMBED_ENTRY_REST_OF_LINE_BUDGET } from './monarch-embed-entry-budget'
import {
  createMonarchTokenizer,
  measureNestedDepth,
  tokenizeMonarchDocument,
  tokenLanguages,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import { svelteMonarchLanguage } from './register-svelte'

// Use real Monarch tokenization; walking valid rule tables previously missed throws on ordinary Svelte expressions.
function tokenizeSvelte(source: string) {
  return tokenizeMonarchDocument('svelte', svelteMonarchLanguage, source)
}

describe('svelte tokenization', () => {
  it('opens a file on a Svelte block without popping a missing embed', () => {
    // File-start block entries have no HTML embed to pop.
    const [line] = tokenizeSvelte('{#if count > 0}')

    expect(tokenTypeAt(line, 0)).toBe('keyword.control')
    expect(tokenLanguages(line)).toEqual(['svelte', 'typescript', 'svelte'])
  })

  it('keeps repeated closer reentry within the embed budget and recovers on the next line', () => {
    // HTML text between closers forces repeated embed reentry after the fallback.
    const closerWithText = '{/if}a'
    const longLine = `<p>${closerWithText.repeat(1000)}<p>after</p>`
    const tokenizer = createMonarchTokenizer('svelte', svelteMonarchLanguage)
    const measurement = measureNestedDepth(tokenizer, ['<p>before</p>', longLine, '<p>next</p>'])
    expect(measurement.error).toBeUndefined()
    expect(measurement.maxNestedDepth).toBeGreaterThan(1)
    expect(measurement.maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)

    const lines = tokenizeSvelte(`<p>before</p>\n${longLine}\n<p>next</p>`)
    expect(tokenTypeAt(lines[1], '<p>'.length)).toBe('keyword.control')
    expect(tokenTypeAt(lines[1], '<p>'.length + closerWithText.length * 999)).toBe(
      'keyword.control'
    )
    expect(tokenLanguages(lines[2])).toEqual(['html'])
  })
})
