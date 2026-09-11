import type * as Monaco from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import { EMBED_ENTRY_REST_OF_LINE_BUDGET } from './monarch-embed-entry-budget'
import {
  createMonarchTokenizer,
  DEFAULT_MAX_TOKENIZATION_LINE_LENGTH,
  endEmbeddedLanguages,
  measureNestedDepth,
  tokenizeLines
} from './monarch-tokenizer-test-harness'
import { astroMonarchLanguage } from './register-astro'
import { svelteMonarchLanguage } from './register-svelte'
import { vueMonarchLanguage } from './register-vue'

// Monarch tokenizes embedded languages by mutual recursion: `_nestedTokenize`
// tail-calls `_myTokenize`, which tail-calls `_nestedTokenize` again for every
// embed entered mid-line. V8 has no TCO, so each mid-line embed entry costs
// real JS stack. Before the embed-entry budget, one 17_000-character line of
// `<script></script>` (under Monaco's own 20_000 line cap) reached ~1743 nested
// levels and died with `RangeError: Maximum call stack size exceeded` — the
// renderer-side STATUS_STACK_OVERFLOW this suite guards.

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
])('%s embedded-tokenizer recursion depth', (languageId, language) => {
  it.each(PATHOLOGICAL_LINES)(
    'stays within the embed budget for a line of %s',
    (_name, buildLine) => {
      // Monaco refuses to tokenize at all past its line cap, so the ramp stops
      // where a real editor would.
      const ramp = RAMP.filter(
        (count) => buildLine(count).length < DEFAULT_MAX_TOKENIZATION_LINE_LENGTH
      )
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

  it('tokenizes interpolations without dropping the embed', () => {
    // Regression: monarch honours `nextEmbedded` on a zero-width match only
    // when the token is `@rematch`; with any other token it hits the
    // no-progress `continue` and silently drops the pending embed. Both
    // grammars then reached a `nextEmbedded: '@pop'` rule with no embed
    // active and threw "cannot pop embedded language if not inside one" on
    // the *first* interpolation — the error seen in the field.
    const measurement = measureNestedDepth(createMonarchTokenizer(languageId, language), [
      '<p>a {first} b {second} c</p>'
    ])

    expect(measurement.error).toBeUndefined()
    // Depth > 0 proves the embeds were really entered, not silently skipped.
    expect(measurement.maxNestedDepth).toBeGreaterThan(0)
  })

  it.each([
    ['script', 'ts', 'typescript'],
    ['style', 'scss', 'scss']
  ])('re-embeds a %s body after an over-budget opening line', (tag, lang, embeddedLanguageId) => {
    // The opening tag plus code on the same line pushes the tag close past the
    // budget, so the body starts unembedded. Every following short line must
    // recover the embed (and the `lang=` language) instead of leaving the whole
    // block unhighlighted until the closing tag.
    const embeds = endEmbeddedLanguages(
      tokenizeLines(createMonarchTokenizer(languageId, language), [
        `<${tag} lang="${lang}">a = "${'x'.repeat(EMBED_ENTRY_REST_OF_LINE_BUDGET)}"`,
        '  b',
        '  c',
        `</${tag}>`
      ])
    )

    expect(embeds).toEqual([null, embeddedLanguageId, embeddedLanguageId, null])
  })

  it('keeps tokenizing after an over-budget line and re-embeds on the next one', () => {
    const overBudget = `<div class="${'x'.repeat(EMBED_ENTRY_REST_OF_LINE_BUDGET)}">{value}</div>`
    const measurement = measureNestedDepth(createMonarchTokenizer(languageId, language), [
      overBudget,
      '<p>{value}</p>'
    ])

    expect(measurement.error).toBeUndefined()
    expect(measurement.maxNestedDepth).toBeGreaterThan(0)
  })
})

describe('unguarded embedded tokenizer', () => {
  // Control: the same markup/expression shape with no budget on embed entry.
  // Depth then tracks the interpolation count one-for-one, which is what took
  // the renderer down; ~1700 levels is already a RangeError in this runtime,
  // so the ramp stops short of the overflow to stay deterministic.
  const perInterpolationEmbedLanguage: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenizer: {
      root: [[/</, { token: '', switchTo: '@markup', nextEmbedded: 'html' }]],
      markup: [[/\{/, { token: '', switchTo: '@expressionEnter', nextEmbedded: '@pop' }]],
      expressionEnter: [[/./, { token: '', switchTo: '@expression', nextEmbedded: 'typescript' }]],
      expression: [[/\}/, { token: '', switchTo: '@markupReenter', nextEmbedded: '@pop' }]],
      markupReenter: [[/./, { token: '', switchTo: '@markup', nextEmbedded: 'html' }]]
    }
  }

  it('recurses once per interpolation', () => {
    const depths = [50, 200, 500].map(
      (count) =>
        measureNestedDepth(createMonarchTokenizer('control', perInterpolationEmbedLanguage), [
          `${interpolationLine(count)} `
        ]).maxNestedDepth
    )

    expect(depths).toEqual([51, 201, 501])
  })
})

describe('vue embedded-tokenizer recursion depth', () => {
  const templateLine = (count: number): string =>
    `<template><p>${'{{a}}'.repeat(count)}</p></template>`

  it('stays within the embed budget for a line of interpolations', () => {
    const ramp = [50, 200, 1000, 2500, 3900].filter(
      (count) => templateLine(count).length < DEFAULT_MAX_TOKENIZATION_LINE_LENGTH
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

  it.each([
    ['script', 'ts', 'typescript'],
    ['style', 'scss', 'scss']
  ])('re-embeds a %s body after an over-budget opening line', (tag, lang, embeddedLanguageId) => {
    const embeds = endEmbeddedLanguages(
      tokenizeLines(createMonarchTokenizer('vue', vueMonarchLanguage), [
        `<${tag} lang="${lang}">a = "${'x'.repeat(EMBED_ENTRY_REST_OF_LINE_BUDGET)}"`,
        '  b',
        `</${tag}>`
      ])
    )

    expect(embeds).toEqual([null, embeddedLanguageId, null])
  })

  it('tokenizes a template interpolation without dropping the embed', () => {
    const measurement = measureNestedDepth(createMonarchTokenizer('vue', vueMonarchLanguage), [
      '<template>',
      '  <p>{{ a }} and {{ b }}</p>',
      '</template>'
    ])

    expect(measurement.error).toBeUndefined()
    expect(measurement.maxNestedDepth).toBeGreaterThan(0)
  })
})
