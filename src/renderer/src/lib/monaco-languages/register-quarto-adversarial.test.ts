import { describe, expect, it } from 'vitest'
import {
  createMonarchTokenizer,
  endEmbeddedLanguages,
  measureNestedDepth,
  tokenizeMonarchDocument,
  tokenTypeAt
} from './monarch-tokenizer-test-harness'
import { EMBED_ENTRY_REST_OF_LINE_BUDGET } from './monarch-embed-entry-budget'
import { QUARTO_LANGUAGE_ID, quartoMonarchLanguage } from './register-quarto'

const FENCE = '```'

function tokenize(source: string[]) {
  return tokenizeMonarchDocument(QUARTO_LANGUAGE_ID, quartoMonarchLanguage, source.join('\n'))
}

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

  it('preserves ordinary inline script and style highlighting', () => {
    for (const tag of ['script', 'style']) {
      const lines = tokenize([`<${tag}>x</${tag}>`, '# After'])
      expect(lines[0].tokens.some((token) => token.language !== QUARTO_LANGUAGE_ID)).toBe(true)
      expect(tokenTypeAt(lines[1], 0)).toBe('keyword')
    }
  })

  it('does not treat front matter after a blank first line as YAML', () => {
    expect(endEmbeddedLanguages(tokenize(['', '---', 'title: demo', '---']))).toEqual([
      null,
      null,
      null,
      null
    ])
  })

  it('keeps malformed cell headers out of embedded languages', () => {
    for (const header of ['{python', '{=}', '{}', '{{python}']) {
      expect(endEmbeddedLanguages(tokenize([`${FENCE}${header}`, 'x', FENCE]))).not.toContain(
        'python'
      )
    }
  })

  it('does not close cells on fence-like code or trailing text', () => {
    expect(
      endEmbeddedLanguages(
        tokenize([`${FENCE}{python}`, `${FENCE} python`, `${FENCE} # comment`, FENCE, '# After'])
      )
    ).toEqual(['python', 'python', 'python', null, null])
  })

  it('closes unknown engines and escaped long fences without swallowing headings', () => {
    for (const header of ['{unknown-engine}', '{{python}}']) {
      const lines = tokenize([`\`\`\`\`${header}`, FENCE, 'inside', '`````', '# After'])
      expect(lines[3].endEmbeddedLanguageId).toBeNull()
      expect(tokenTypeAt(lines[4], 0)).toBe('keyword')
    }
  })

  it('accepts YAML end markers and whitespace after closing fences', () => {
    expect(
      endEmbeddedLanguages(
        tokenize(['---', 'title: demo', '...', `${FENCE}{r}`, 'x <- 1', `${FENCE}  \t`, '# After'])
      )
    ).toEqual(['yaml', 'yaml', null, 'r', 'r', null, null])
  })
})
