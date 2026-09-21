import { describe, expect, it, vi } from 'vitest'
import {
  createMonarchTokenizer,
  endEmbeddedLanguages,
  measureNestedDepth,
  tokenizeMonarchDocument,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import {
  QUARTO_LANGUAGE_ID,
  quartoLanguageConfiguration,
  quartoMonarchLanguage,
  registerQuartoLanguage
} from './register-quarto'

const FENCE = '```'
const LONG_FENCE = '````'

function tokenizeQuarto(source: string) {
  return tokenizeMonarchDocument(QUARTO_LANGUAGE_ID, quartoMonarchLanguage, source)
}

function embedsFor(source: string): (string | null)[] {
  return endEmbeddedLanguages(tokenizeQuarto(source))
}

function createMonacoMock(existingLanguageIds: string[] = ['markdown']) {
  const languages = existingLanguageIds.map((id) => ({ id }))
  return {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn((entry: { id: string }) => {
        languages.push({ id: entry.id })
      }),
      setLanguageConfiguration: vi.fn(),
      setMonarchTokensProvider: vi.fn()
    }
  }
}

describe('registerQuartoLanguage', () => {
  it('registers the quarto language, tokenizer, and configuration once', () => {
    const monaco = createMonacoMock()

    registerQuartoLanguage(monaco as never)
    registerQuartoLanguage(monaco as never)

    expect(monaco.languages.register).toHaveBeenCalledTimes(1)
    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: QUARTO_LANGUAGE_ID,
        extensions: ['.qmd', '.rmd', '.rmarkdown']
      })
    )
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      QUARTO_LANGUAGE_ID,
      quartoMonarchLanguage
    )
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      QUARTO_LANGUAGE_ID,
      quartoLanguageConfiguration
    )
  })

  it('hands a leading --- block to yaml and returns to markdown', () => {
    expect(embedsFor(['---', 'format: revealjs', '---', '# Title'].join('\n'))).toEqual([
      'yaml',
      'yaml',
      null,
      null
    ])
  })

  it('treats a mid-document --- as markdown, not front matter', () => {
    // Why: revealjs decks use `---` as a slide separator, so only line 1 may open YAML.
    expect(embedsFor(['# Title', '', '---', '', '## Next slide'].join('\n'))).toEqual([
      null,
      null,
      null,
      null,
      null
    ])
  })

  it('colors executable cells with the engine language', () => {
    expect(
      embedsFor([`${FENCE}{r setup, include=FALSE}`, 'x <- 1', FENCE, 'after'].join('\n'))
    ).toEqual(['r', 'r', null, null])
    expect(embedsFor([`${FENCE}{python}`, 'print(1)', FENCE].join('\n'))).toEqual([
      'python',
      'python',
      null
    ])
    expect(embedsFor([`${FENCE}{=html}`, '<b>x</b>', FENCE].join('\n'))[0]).toBe('html')
    // {ojs} and {d3} are JavaScript dialects Monaco has no language id for.
    expect(embedsFor([`${FENCE}{ojs}`, 'x = 1', FENCE].join('\n'))[0]).toBe('javascript')
  })

  it('leaves an engine Monaco does not know uncolored instead of failing', () => {
    expect(embedsFor([`${FENCE}{tikz}`, '\\draw;', FENCE, 'after'].join('\n'))).toEqual([
      'tikz',
      'tikz',
      null,
      null
    ])
  })

  it('keeps an escaped ```{{python}} cell out of the engine tokenizer', () => {
    // Why: Quarto's double-brace form shows a cell without running it.
    const lines = tokenizeQuarto([`${FENCE}{{python}}`, 'print(1)', FENCE, '## After'].join('\n'))
    expect(endEmbeddedLanguages(lines)).toEqual([null, null, null, null])
    expect(tokenTypeAt(lines[3], 0)).toBe('keyword')
  })

  it('closes a cell only on a fence at least as long as the one that opened it', () => {
    // Why: markdown's own code-block states close on exactly three backticks, so a
    // ````-fenced cell used to run to the end of the file.
    expect(
      embedsFor(
        [
          `${LONG_FENCE}{python}`,
          `print("${FENCE}")`,
          FENCE,
          'still inside',
          LONG_FENCE,
          '# After'
        ].join('\n')
      )
    ).toEqual(['python', 'python', 'python', 'python', null, null])
    // A closing fence longer than the opener still closes, as CommonMark requires.
    expect(embedsFor([`${FENCE}{r}`, 'x', LONG_FENCE, '# After'].join('\n'))).toEqual([
      'r',
      'r',
      null,
      null
    ])
  })

  it('routes long plain fences through the same fence-aware states', () => {
    // Why: ````-fenced blocks are how a Quarto document shows a ``` fence, and
    // markdown's own fence rules stop at three backticks.
    const lines = tokenizeQuarto(
      [LONG_FENCE, `${FENCE}r`, 'x', FENCE, LONG_FENCE, '## After'].join('\n')
    )
    expect(endEmbeddedLanguages(lines)).toEqual([null, null, null, null, null, null])
    expect(tokenTypeAt(lines[5], 0)).toBe('keyword')
  })

  it('keeps plain markdown fences and headings working', () => {
    expect(embedsFor([`${FENCE}python`, 'print(1)', FENCE, 'text'].join('\n'))).toEqual([
      'python',
      'python',
      null,
      null
    ])
    const heading = tokenizeQuarto('## Slide title')[0]
    expect(tokenTypeAt(heading, 0)).toBe('keyword')
  })

  it('enters an embed only at the start of a line, so the embed-entry budget does not apply', () => {
    // Why: `monarch-embed-entry-budget` guards grammars that enter an embed
    // mid-line — a `<script>` tag, a `{expr}` — where each entry holds a JS stack
    // frame until the line ends. A Quarto cell opens on a whole fence line, so
    // however long a line inside the cell is, it adds no further entries.
    const tokenizer = createMonarchTokenizer(QUARTO_LANGUAGE_ID, quartoMonarchLanguage)
    const { maxNestedDepth, error } = measureNestedDepth(tokenizer, [
      `${FENCE}{python}`,
      `print("${'{a}'.repeat(5000)}")`,
      FENCE
    ])

    expect(error).toBeUndefined()
    expect(maxNestedDepth).toBeLessThanOrEqual(1)
  })

  it('marks pandoc fenced divs', () => {
    const lines = tokenizeQuarto(['::: {.callout-note}', 'text', ':::'].join('\n'))
    expect(tokenTypeAt(lines[0], 0)).toBe('meta.separator')
    expect(tokenTypeAt(lines[2], 0)).toBe('meta.separator')
  })
})
