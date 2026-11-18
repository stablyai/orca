import { describe, expect, it } from 'vitest'
import {
  EMBED_ENTRY_REST_OF_LINE_BUDGET,
  MAX_TOKENIZATION_LINE_LENGTH
} from './monarch-embed-entry-budget'
import { createMonarchTokenizer, measureNestedDepth } from './monarch-tokenizer-test-harness'
import { astroMonarchLanguage } from './register-astro'
import { glimmerTsMonarchLanguage } from './register-glimmer'
import { svelteMonarchLanguage } from './register-svelte'
import { vueMonarchLanguage } from './register-vue'

// Monarch tokenizes embedded languages by mutual recursion: `_nestedTokenize`
// tail-calls `_myTokenize`, which tail-calls `_nestedTokenize` again for every
// embed entered mid-line. V8 has no TCO, so each mid-line embed entry costs
// real JS stack. Embeds cannot nest (monarchLexer throws "cannot enter embedded
// language from within an embedded language"), so these are sequential
// enter/exit transitions on one line, each holding a frame until the line ends.
//
// Before the embed-entry budget, one 17_000-character line of `<script></script>`
// (under Monaco's own 20_000 line cap) reached ~1743 frames and threw
// `RangeError: Maximum call stack size exceeded`. Monaco's `safeTokenize` catches
// that per line, so the visible failure is a line that silently loses all
// highlighting; the frame count is what this suite bounds.

// 6600 is the largest `{a}` count under Monaco's line cap (19_800 chars); the
// filter below drops it for the longer chunk shapes, so the densest embed
// shape is the one that gets driven at maximum length.
const RAMP = [50, 200, 500, 1000, 2500, 6600]

function interpolationLine(count: number): string {
  return `<p>${Array.from({ length: count }, (_, index) => `{a${index}}`).join('')}</p>`
}

function repeatedLine(count: number, chunk: string): string {
  return `<p>${chunk.repeat(count)}`
}

const PATHOLOGICAL_LINES: [string, (count: number) => string][] = [
  ['interpolations', interpolationLine],
  // Densest embed entries per character: two embeds (typescript, then html
  // again) per three characters.
  ['back-to-back interpolations', (count) => '{a}'.repeat(count)],
  ['html comments', (count) => repeatedLine(count, '<!---->')],
  ['script tags', (count) => repeatedLine(count, '<script>a</script>')],
  ['style tags', (count) => repeatedLine(count, '<style>a{b:c}</style>')]
]

describe.each([
  ['svelte', svelteMonarchLanguage],
  ['astro', astroMonarchLanguage]
])('%s embed-entry recursion', (languageId, language) => {
  it.each(PATHOLOGICAL_LINES)(
    'stays within the embed budget for a line of %s',
    (_name, buildLine) => {
      // Monaco refuses to tokenize at all past its line cap, so the ramp stops
      // where a real editor would.
      const ramp = RAMP.filter((count) => buildLine(count).length < MAX_TOKENIZATION_LINE_LENGTH)
      expect(ramp.length).toBeGreaterThanOrEqual(3)

      const depths = ramp.map((count) =>
        measureNestedDepth(createMonarchTokenizer(languageId, language), [buildLine(count)])
      )

      for (const measurement of depths) {
        expect(measurement.error).toBeUndefined()
        expect(measurement.maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)
      }
      // Depth must stop tracking the occurrence count, not merely grow slower.
      expect(Math.max(...depths.map((measurement) => measurement.maxNestedDepth))).toBeLessThan(
        ramp.at(-1) as number
      )
    }
  )
})

describe('vue embed-entry recursion', () => {
  const templateLine = (count: number): string =>
    `<template><p>${'{{a}}'.repeat(count)}</p></template>`

  it('stays within the embed budget for a line of interpolations', () => {
    const ramp = [50, 200, 1000, 2500, 3900].filter(
      (count) => templateLine(count).length < MAX_TOKENIZATION_LINE_LENGTH
    )
    expect(ramp.length).toBeGreaterThanOrEqual(3)

    const depths = ramp.map((count) =>
      measureNestedDepth(createMonarchTokenizer('vue', vueMonarchLanguage), [templateLine(count)])
    )

    for (const measurement of depths) {
      expect(measurement.error).toBeUndefined()
      expect(measurement.maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)
    }
    expect(Math.max(...depths.map((measurement) => measurement.maxNestedDepth))).toBeLessThan(
      ramp.at(-1) as number
    )
  })
})

describe('glimmer embed-entry recursion', () => {
  const islandLine = (count: number): string =>
    `const a = 1; ${'<template>a</template>'.repeat(count)}`

  it('stays within the embed budget for a line of template islands', () => {
    const ramp = [50, 200, 500, 900].filter(
      (count) => islandLine(count).length < MAX_TOKENIZATION_LINE_LENGTH
    )
    expect(ramp.length).toBeGreaterThanOrEqual(3)

    const depths = ramp.map((count) =>
      measureNestedDepth(createMonarchTokenizer('glimmer-ts', glimmerTsMonarchLanguage), [
        islandLine(count)
      ])
    )

    for (const measurement of depths) {
      expect(measurement.error).toBeUndefined()
      expect(measurement.maxNestedDepth).toBeLessThanOrEqual(EMBED_ENTRY_REST_OF_LINE_BUDGET)
    }
  })
})
