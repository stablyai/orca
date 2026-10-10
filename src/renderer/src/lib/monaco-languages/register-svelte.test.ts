import { describe, expect, it, vi } from 'vitest'
import { EMBED_ENTRY_REST_OF_LINE_BUDGET } from './monarch-embed-entry-budget'
import {
  createMonarchTokenizer,
  endEmbeddedLanguages,
  formatTokenizedLines,
  measureNestedDepth,
  tokenizeMonarchDocument,
  tokenLanguages,
  tokenLanguagesPerLine,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import {
  registerSvelteLanguage,
  svelteLanguageConfiguration,
  svelteMonarchLanguage
} from './register-svelte'

// These tests drive the real `MonarchTokenizer`. Walking the rule table instead
// let a grammar that threw on 100% of Svelte inputs — including `<p>a {b}</p>` —
// ship with a green suite, because a broken grammar still has a valid table.
function tokenizeSvelte(source: string) {
  return tokenizeMonarchDocument('svelte', svelteMonarchLanguage, source)
}

/** Which languages actually cover each line — a dropped embed shows up as `svelte`. */
function languagesPerLine(source: string): string[][] {
  return tokenLanguagesPerLine(tokenizeSvelte(source))
}

describe('registerSvelteLanguage registration', () => {
  // Structural by necessity: this covers the registration call itself
  // (ids, extensions, idempotence), which no amount of tokenizing can observe.
  it('registers the svelte language, Monarch tokenizer, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'typescript' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const getLanguages = vi.fn(() => languages)
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages
      }
    }

    registerSvelteLanguage(monacoMock as never)
    registerSvelteLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'svelte',
      extensions: ['.svelte'],
      aliases: ['Svelte']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('svelte', svelteMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('svelte', svelteLanguageConfiguration)
  })
})

describe('svelte tokenization', () => {
  it('tokenizes a representative SFC', () => {
    const fixture = `<script lang="ts">
  let count = 0
  $: doubled = count * 2
</script>

<h1>Counter</h1>
{#if count > 0}
  <p>{count} clicked</p>
{:else}
  <p>not yet</p>
{/if}

<button on:click={increment}>{count}</button>
{@html '<em>raw</em>'}

<style>
  h1 { color: rebeccapurple; }
</style>`

    expect(formatTokenizedLines(tokenizeSvelte(fixture))).toMatchInlineSnapshot(`
      [
        "<script lang="ts"> | 0:tag.svelte@svelte 7:white.svelte@svelte 8:attribute.name.svelte@svelte 12:delimiter.svelte@svelte 13:attribute.value.svelte@svelte 17:tag.svelte@svelte | embed=typescript",
        "  let count = 0 | 0:-@typescript | embed=typescript",
        "  $: doubled = count * 2 | 0:-@typescript | embed=typescript",
        "</script> | 0:tag.svelte@svelte | embed=none",
        " |  | embed=html",
        "<h1>Counter</h1> | 0:-@html | embed=html",
        "{#if count > 0} | 0:keyword.control.svelte@svelte 4:-@typescript 14:keyword.control.svelte@svelte | embed=none",
        "  <p>{count} clicked</p> | 0:-@html 5:delimiter.curly.svelte@svelte 6:-@typescript 11:delimiter.curly.svelte@svelte 12:-@html | embed=html",
        "{:else} | 0:keyword.control.svelte@svelte | embed=none",
        "  <p>not yet</p> | 0:-@html | embed=html",
        "{/if} | 0:keyword.control.svelte@svelte | embed=none",
        " |  | embed=html",
        "<button on:click={increment}>{count}</button> | 0:-@html 17:delimiter.curly.svelte@svelte 18:-@typescript 27:delimiter.curly.svelte@svelte 28:-@html 29:delimiter.curly.svelte@svelte 30:-@typescript 35:delimiter.curly.svelte@svelte 36:-@html | embed=html",
        "{@html '<em>raw</em>'} | 0:keyword.control.svelte@svelte 6:-@typescript 21:delimiter.curly.svelte@svelte | embed=none",
        " |  | embed=html",
        "<style> | 0:tag.svelte@svelte | embed=css",
        "  h1 { color: rebeccapurple; } | 0:-@css | embed=css",
        "</style> | 0:tag.svelte@svelte | embed=none",
      ]
    `)
  })

  // Regression (the field failure): the first interpolation of a file threw
  // "cannot pop embedded language if not inside one" — every Svelte file with a
  // `{}` in it, which is essentially all of them.
  it('highlights every interpolation of a markup line', () => {
    const [line] = tokenizeSvelte('<p>a {first} b {second} c</p>')

    expect(tokenLanguages(line)).toEqual([
      'html',
      'svelte',
      'typescript',
      'svelte',
      'html',
      'svelte',
      'typescript',
      'svelte',
      'html'
    ])
  })

  it('opens a file on a Svelte block without popping a missing embed', () => {
    // No html embed exists yet at file start, so the block's entry rule must not
    // pop one — Monarch throws outright if it does.
    const [line] = tokenizeSvelte('{#if count > 0}')

    expect(tokenTypeAt(line, 0)).toBe('keyword.control')
    expect(tokenLanguages(line)).toEqual(['svelte', 'typescript', 'svelte'])
  })

  it('enters the html embed when markup begins', () => {
    expect(endEmbeddedLanguages(tokenizeSvelte('<h1>Counter</h1>'))).toEqual(['html'])
  })

  it('pops the html embed for a comment that follows markup', () => {
    // Once html is active Monaco only consults parent rules that pop the embed,
    // so `<!--` after markup is unreachable without one.
    expect(languagesPerLine('<h1>hi</h1>\n<!-- a note -->\n<p>after</p>')).toEqual([
      ['html'],
      ['svelte'],
      ['html']
    ])
  })

  it('keeps markup embedded across a Svelte block', () => {
    expect(
      languagesPerLine(
        '<h1>hi</h1>\n{#if ok}\n  <p>yes</p>\n{:else}\n  <p>no</p>\n{/if}\n<p>done</p>'
      )
    ).toEqual([
      ['html'],
      ['svelte', 'typescript', 'svelte'],
      ['html'],
      ['svelte'],
      ['html'],
      ['svelte'],
      ['html']
    ])
  })

  it.each(['if', 'each', 'await', 'key', 'snippet'])(
    'highlights %s closers and resumes HTML with or without whitespace',
    (name) => {
      for (const closer of [`{/${name}}`, `{ \t/${name} \t}`]) {
        const lines = tokenizeSvelte(`<p>before</p>\n${closer}\n<p>after</p>`)
        expect(tokenTypeAt(lines[1], 0)).toBe('keyword.control')
        expect(tokenLanguages(lines[1])).toEqual(['svelte'])
        expect(tokenLanguages(lines[2])).toEqual(['html'])

        const [sameLine] = tokenizeSvelte(`<p>before</p>${closer}<p>after</p>`)
        expect(tokenTypeAt(sameLine, '<p>before</p>'.length)).toBe('keyword.control')
        expect(tokenLanguages(sameLine)).toEqual(['html', 'svelte', 'html'])

        const [fileStartCloser] = tokenizeSvelte(closer)
        expect(tokenTypeAt(fileStartCloser, 0)).toBe('keyword.control')
        expect(tokenLanguages(fileStartCloser)).toEqual(['svelte'])
      }
    }
  )

  it('preserves a CSS block after a Svelte closer', () => {
    expect(
      languagesPerLine(
        '{#each items as item}\n  <p>{item}</p>\n{/each}\n<style>\n  p { color: red; }\n</style>'
      )
    ).toEqual([
      ['svelte', 'typescript', 'svelte'],
      ['html', 'svelte', 'typescript', 'svelte', 'html'],
      ['svelte'],
      ['svelte'],
      ['css'],
      ['svelte']
    ])
  })

  it('resumes HTML, expressions, script and CSS after an inline closer', () => {
    const source =
      '<p>before</p>{/if}<p>{value}</p><script>let a = 1</script><style>p {color:red}</style>'
    expect(tokenLanguages(tokenizeSvelte(source)[0])).toEqual([
      'html',
      'svelte',
      'html',
      'svelte',
      'typescript',
      'svelte',
      'html',
      'svelte',
      'typescript',
      'svelte',
      'css',
      'svelte'
    ])
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

  it('keeps markup highlighted across a whole multi-line file', () => {
    // A grammar that drops the embed leaves plain `svelte` on these rows, which
    // is the silently-unhighlighted failure a rule-table walk cannot see.
    expect(
      languagesPerLine(
        '<h1>hi</h1>\n<p>{a}</p>\n<!-- note -->\n<p>{b}</p>\n<button on:click={go}>x</button>'
      )
    ).toEqual([
      ['html'],
      ['html', 'svelte', 'typescript', 'svelte', 'html'],
      ['svelte'],
      ['html', 'svelte', 'typescript', 'svelte', 'html'],
      ['html', 'svelte', 'typescript', 'svelte', 'html']
    ])
  })

  it('does not enter typescript for an empty expression', () => {
    // `{}` pops html on entry but never pushes typescript; the close must unwind
    // only the state, or the tokenizer pops an embed that is not there.
    expect(tokenLanguages(tokenizeSvelte('<p>{}</p>')[0])).toEqual(['html', 'svelte', 'html'])
  })
})

describe('svelte embedded language attributes', () => {
  // `lang=` picks the embedded language for the block body. The assertion is on
  // the body row, which is the region a reader sees highlighted (or not).
  it.each([
    ['<script>', 'typescript'],
    ['<script lang="ts">', 'typescript'],
    ['<script lang="typescript">', 'typescript'],
    ['<script lang="js">', 'javascript'],
    ["<script lang='javascript'>", 'javascript'],
    ['<script lang=js>', 'javascript'],
    ['<script lang="unknown">', 'typescript']
  ])('embeds a %s body as %s', (openingTag, embeddedLanguageId) => {
    expect(languagesPerLine(`<h1>hi</h1>\n${openingTag}\n  a\n</script>`)).toEqual([
      ['html'],
      ['svelte'],
      [embeddedLanguageId],
      ['svelte']
    ])
  })

  it.each([
    ['<style>', 'css'],
    ['<style lang="css">', 'css'],
    ['<style lang="scss">', 'scss'],
    ["<style lang='sass'>", 'scss'],
    ['<style lang=less>', 'less'],
    ['<style lang="unknown">', 'css']
  ])('embeds a %s body as %s', (openingTag, embeddedLanguageId) => {
    expect(languagesPerLine(`<h1>hi</h1>\n${openingTag}\n  h1 { color: red; }\n</style>`)).toEqual([
      ['html'],
      ['svelte'],
      [embeddedLanguageId],
      ['svelte']
    ])
  })
})

describe('svelte root state invariant', () => {
  // Structural on purpose: behaviour can only reach the root rules some fixture
  // happens to exercise, and a root rule that pops an embed throws on the very
  // first character of a file. Guard every root rule, exercised or not.
  it('has no root rule that pops an embedded language', () => {
    const rootRules = (svelteMonarchLanguage.tokenizer as Record<string, unknown[]>).root
    const popRules = rootRules.filter(
      (rule) =>
        Array.isArray(rule) && (rule[1] as { nextEmbedded?: string })?.nextEmbedded === '@pop'
    )

    expect(popRules).toEqual([])
  })
})
