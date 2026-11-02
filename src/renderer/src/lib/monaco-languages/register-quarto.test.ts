import { describe, expect, it } from 'vitest'
import {
  endEmbeddedLanguages,
  tokenizeMonarchDocument,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import { QUARTO_LANGUAGE_ID, quartoMonarchLanguage } from './register-quarto'

const FENCE = '```'
const LONG_FENCE = '````'

function tokenizeQuarto(source: string) {
  return tokenizeMonarchDocument(QUARTO_LANGUAGE_ID, quartoMonarchLanguage, source)
}

function embedsFor(source: string): (string | null)[] {
  return endEmbeddedLanguages(tokenizeQuarto(source))
}

describe('registerQuartoLanguage', () => {
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

  it('keeps an escaped ```{{python}} cell out of the engine tokenizer', () => {
    // Why: Quarto's double-brace form shows a cell without running it.
    const lines = tokenizeQuarto([`${FENCE}{{python}}`, 'print(1)', FENCE, '## After'].join('\n'))
    expect(endEmbeddedLanguages(lines)).toEqual([null, null, null, null])
    expect(tokenTypeAt(lines[3], 0)).toBe('keyword')
  })

  it('closes a cell only on a fence at least as long as the one that opened it', () => {
    // Honor longer closing fences; Markdown’s built-in three-backtick state could otherwise consume the whole file.
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
    // Four-backtick Quarto blocks can contain literal triple fences; built-in Markdown rules stop too early.
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

  it('marks pandoc fenced divs', () => {
    const lines = tokenizeQuarto(['::: {.callout-note}', 'text', ':::'].join('\n'))
    expect(tokenTypeAt(lines[0], 0)).toBe('meta.separator')
    expect(tokenTypeAt(lines[2], 0)).toBe('meta.separator')
  })
})
