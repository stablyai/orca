// @vitest-environment happy-dom
// Why happy-dom: monaco's `basic-languages` entry points import the full
// browser editor before they export the grammar.
import { language as mdxLanguage } from 'monaco-editor/esm/vs/basic-languages/mdx/mdx.js'
import { describe, expect, it } from 'vitest'
import {
  EMBED_ENTRY_REST_OF_LINE_BUDGET,
  MAX_TOKENIZATION_LINE_LENGTH
} from './monarch-embed-entry-budget'
import { createMonarchTokenizer, measureNestedDepth } from './monarch-tokenizer-test-harness'
import { svelteMonarchLanguage } from './register-svelte'

// Why pin a third-party grammar: monaco's OWN shipped mdx grammar enters a `js`
// embed on every `{` and pops on `}` with no budget, so it reproduces the
// unbounded embed-entry recursion exactly. That makes it the proof this shape is
// monaco's, not something Orca's svelte/astro/vue grammars invented — and it is
// the tripwire for a monaco upgrade that changes the recursion shape. Do not
// delete as "not our code".

/** One `js` embed enter/exit transition per repeat, in 3 characters. */
const interpolations = (count: number): string => '{a}'.repeat(count)

/** Longest run of them monaco will still tokenize at all. */
const UNTOKENIZABLE_ABOVE = Math.floor(MAX_TOKENIZATION_LINE_LENGTH / 3) - 1

describe('upstream monaco mdx grammar', () => {
  it('spends one stack frame per interpolation, unbounded', () => {
    const frames = [50, 200, 500].map(
      (count) =>
        measureNestedDepth(createMonarchTokenizer('mdx', mdxLanguage), [interpolations(count)])
          .maxNestedDepth
    )

    expect(frames).toEqual([50, 200, 500])
  })

  it('exhausts the JS stack on a line monaco is still willing to tokenize', () => {
    const line = interpolations(UNTOKENIZABLE_ABOVE)
    expect(line.length).toBeLessThan(MAX_TOKENIZATION_LINE_LENGTH)

    const measurement = measureNestedDepth(createMonarchTokenizer('mdx', mdxLanguage), [line])

    // The frame ceiling is runtime-dependent (~1145 measured here), so assert the
    // failure rather than the number.
    expect(measurement.error).toBeInstanceOf(RangeError)
    expect(measurement.maxNestedDepth).toBeLessThan(UNTOKENIZABLE_ABOVE)
  })

  it('is what the embed-entry budget holds: the same shape stays bounded', () => {
    const measurement = measureNestedDepth(
      createMonarchTokenizer('svelte', svelteMonarchLanguage),
      [interpolations(UNTOKENIZABLE_ABOVE)]
    )

    expect(measurement.error).toBeUndefined()
    expect(measurement.maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)
  })
})
