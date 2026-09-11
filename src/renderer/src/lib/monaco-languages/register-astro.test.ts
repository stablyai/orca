import { describe, expect, it, vi } from 'vitest'
import {
  endEmbeddedLanguages,
  formatTokenizedLines,
  tokenizeMonarchDocument,
  tokenLanguages,
  tokenLanguagesPerLine
} from './monarch-tokenizer-test-harness'
import {
  astroLanguageConfiguration,
  astroMonarchLanguage,
  registerAstroLanguage
} from './register-astro'

// Driven through the real `MonarchTokenizer`: a rule-table walk cannot tell a
// working grammar from one that throws on every `{expr}`, which is how broken
// Astro highlighting shipped green.
function tokenizeAstro(source: string) {
  return tokenizeMonarchDocument('astro', astroMonarchLanguage, source)
}

/** Which languages actually cover each line — a dropped embed shows up as `astro`. */
function languagesPerLine(source: string): string[][] {
  return tokenLanguagesPerLine(tokenizeAstro(source))
}

describe('registerAstroLanguage registration', () => {
  // Structural by necessity: covers the registration call itself (ids,
  // extensions, idempotence), which tokenizing cannot observe.
  it('registers the astro language, Monarch tokenizer, and configuration once', () => {
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

    registerAstroLanguage(monacoMock as never)
    registerAstroLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'astro',
      extensions: ['.astro'],
      aliases: ['Astro']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('astro', astroMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('astro', astroLanguageConfiguration)
  })
})

describe('astro tokenization', () => {
  it('tokenizes a representative component', () => {
    const fixture = `---
import Layout from '../layouts/Layout.astro'
const title = 'Home'
---

<h1>{title}</h1>

<script>
  console.log('hi')
</script>

<style lang="scss">
  h1 { color: rebeccapurple; }
</style>`

    expect(formatTokenizedLines(tokenizeAstro(fixture))).toMatchInlineSnapshot(`
      [
        "--- | 0:keyword.astro@astro | embed=typescript",
        "import Layout from '../layouts/Layout.astro' | 0:-@typescript | embed=typescript",
        "const title = 'Home' | 0:-@typescript | embed=typescript",
        "--- | 0:keyword.astro@astro | embed=none",
        " |  | embed=html",
        "<h1>{title}</h1> | 0:-@html 4:delimiter.curly.astro@astro 5:-@typescript 10:delimiter.curly.astro@astro 11:-@html | embed=html",
        " | 0:-@html | embed=html",
        "<script> | 0:tag.astro@astro | embed=javascript",
        "  console.log('hi') | 0:-@javascript | embed=javascript",
        "</script> | 0:tag.astro@astro | embed=none",
        " |  | embed=html",
        "<style lang="scss"> | 0:tag.astro@astro 6:white.astro@astro 7:attribute.name.astro@astro 11:delimiter.astro@astro 12:attribute.value.astro@astro 18:tag.astro@astro | embed=scss",
        "  h1 { color: rebeccapurple; } | 0:-@scss | embed=scss",
        "</style> | 0:tag.astro@astro | embed=none",
      ]
    `)
  })

  it('embeds the frontmatter fence as typescript', () => {
    expect(
      endEmbeddedLanguages(tokenizeAstro("---\nconst title = 'Home'\n---\n<h1>hi</h1>"))
    ).toEqual(['typescript', 'typescript', null, 'html'])
  })

  // Regression (verified live in the Electron app): an expression in the first
  // markup line popped the html embed before any push, and Monarch threw
  // "cannot pop embedded language if not inside one".
  it('highlights an expression in the first markup line', () => {
    const [line] = tokenizeAstro('<p>a {title} b</p>')

    expect(tokenLanguages(line)).toEqual(['html', 'astro', 'typescript', 'astro', 'html'])
  })

  it('opens a file on an expression without popping a missing embed', () => {
    // A file with no frontmatter that starts on `{expr}`: no html embed exists
    // yet, so the entry rule must not pop one.
    expect(tokenLanguages(tokenizeAstro('{title}')[0])).toEqual(['astro', 'typescript', 'astro'])
  })

  it('pops the html embed for a comment that follows markup', () => {
    expect(languagesPerLine('<h1>hi</h1>\n<!-- a note -->\n<p>{x}</p>')).toEqual([
      ['html'],
      ['astro'],
      ['html', 'astro', 'typescript', 'astro', 'html']
    ])
  })

  it('does not enter typescript for an empty expression', () => {
    // `{}` pops html on entry but never pushes typescript; the close must unwind
    // only the state, or the tokenizer pops an embed that is not there.
    expect(tokenLanguages(tokenizeAstro('<p>{}</p>')[0])).toEqual(['html', 'astro', 'html'])
  })
})

describe('astro embedded language attributes', () => {
  // Astro `<script>` defaults to JavaScript (unlike Svelte/Vue).
  it.each([
    ['<script>', 'javascript'],
    ['<script lang="js">', 'javascript'],
    ['<script lang="ts">', 'typescript'],
    ["<script lang='typescript'>", 'typescript'],
    ['<script lang=ts>', 'typescript'],
    ['<script lang="unknown">', 'javascript']
  ])('embeds a %s body as %s', (openingTag, embeddedLanguageId) => {
    expect(languagesPerLine(`<h1>hi</h1>\n${openingTag}\n  a\n</script>`)).toEqual([
      ['html'],
      ['astro'],
      [embeddedLanguageId],
      ['astro']
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
      ['astro'],
      [embeddedLanguageId],
      ['astro']
    ])
  })
})

describe('astro root state invariant', () => {
  // Structural on purpose: behaviour can only reach the root rules some fixture
  // happens to exercise, and a root rule that pops an embed throws on the very
  // first character of a file. Guard every root rule, exercised or not.
  it('has no root rule that pops an embedded language', () => {
    const rootRules = (astroMonarchLanguage.tokenizer as Record<string, unknown[]>).root
    const popRules = rootRules.filter(
      (rule) =>
        Array.isArray(rule) && (rule[1] as { nextEmbedded?: string })?.nextEmbedded === '@pop'
    )

    expect(popRules).toEqual([])
  })
})
