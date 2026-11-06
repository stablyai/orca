import { describe, expect, it } from 'vitest'
import { htmlRendersAsText } from './comment-markdown-unknown-html-as-text'
import { splitMarkdownTopLevelBlocks, type MarkdownBlockSplit } from './markdown-top-level-blocks'

const REPLY = [
  'Here is the plan.',
  '',
  '## Steps',
  '',
  '- first item',
  '- second item',
  '',
  '  continued inside the list',
  '',
  '1. one',
  '2. two',
  '',
  'A loose list follows.',
  '',
  '1. first',
  '',
  '2. second',
  '',
  '   with a paragraph of its own',
  '',
  '3. third',
  '',
  '> a quote',
  'that continues lazily',
  '',
  '```ts',
  'const a = 1',
  '',
  '## not a heading',
  '```',
  '',
  'Intro to the table',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Setext title',
  '===',
  '',
  'Closing words with `code` and **bold**.',
  ''
].join('\n')

function streamed(source: string, step: number): string[] {
  let split: MarkdownBlockSplit | null = null
  for (let end = step; end < source.length + step; end += step) {
    split = splitMarkdownTopLevelBlocks(source.slice(0, end), split)
  }
  return (split?.blocks ?? []).map((block) => block.text)
}

function cut(source: string, previous: MarkdownBlockSplit | null = null): string[] {
  return splitMarkdownTopLevelBlocks(source, previous).blocks.map((block) => block.text)
}

describe('splitMarkdownTopLevelBlocks', () => {
  it.each([1, 3, 7])('reaches the same cut when streamed %i characters at a time', (step) => {
    expect(streamed(REPLY, step)).toEqual(cut(REPLY))
  })

  it.each([
    ['a link definition', 'See [the docs][docs].\n\nMore.\n\n[docs]: https://example.com\n'],
    ['a footnote', 'A claim.[^1]\n\nMore.\n\n[^1]: The source.\n'],
    ['a nested definition', 'See [the docs][docs].\n\n> [docs]: https://example.com\n'],
    ['raw HTML', 'Before.\n\n<details>\n\nhidden **text**\n\n</details>\n'],
    ['raw HTML inside a quote', 'Before.\n\n> <table><tr><td>cell\n\nAfter.\n'],
    ['an inline tag left open', 'Before <sub>low.\n\nAfter.\n']
  ])('leaves a document with %s whole, however it arrived', (_name, source) => {
    expect(cut(source)).toEqual([source])
    expect(streamed(source, 2)).toEqual([source])
  })

  describe('when unknown HTML renders as text', () => {
    const rendersAsText = (html: string): boolean =>
      htmlRendersAsText(html, new Set(['b', 'sub', 'details']))
    function streamedAsText(source: string): string[] {
      let split: MarkdownBlockSplit | null = null
      for (let end = 2; end < source.length + 2; end += 2) {
        split = splitMarkdownTopLevelBlocks(
          source.slice(0, end),
          split,
          true,
          undefined,
          undefined,
          rendersAsText
        )
      }
      return (split?.blocks ?? []).map((block) => block.text)
    }

    it.each([
      ['a type parameter', 'A Vec<T> of Promise<void>.\n\nAfter.\n', 2],
      ['an unknown tag block', '<example>\n\nInside.\n\n</example>\n', 3]
    ])('keeps cutting a document with %s', (_name, source, blocks) => {
      expect(streamedAsText(source)).toHaveLength(blocks)
      expect(streamedAsText(source).join('')).toBe(source)
    })

    it.each([
      ['a kept tag', 'Before <sub>low</sub>.\n\nAfter.\n'],
      ['a kept tag beside an unknown one', 'A <example><b>bold</b>.\n\nAfter.\n'],
      [
        'bold the HTML parser carries out of a table',
        '<b><table><tr><td>one</b></td></tr></table>\n\nAfter.\n'
      ],
      ['a comment', '<!-- a --!><b>oops -->\n\nAfter.\n'],
      ['a malformed kept tag', '<details title=a<>\n\nAfter **x**\n']
    ])('leaves a document with %s whole', (_name, source) => {
      expect(streamedAsText(source)).toEqual([source])
    })

    it('leaves raw unknown HTML whole when it does not render as text', () => {
      expect(cut('<select>\n\nAfter **bold**.\n')).toHaveLength(1)
      expect(cut('A Vec<T>.\n\nAfter.\n')).toHaveLength(1)
    })
  })

  it('starts over when the source is replaced rather than appended to', () => {
    const first = splitMarkdownTopLevelBlocks('one\n\ntwo\n', null)
    expect(cut('other\n\ntext\n', first)).toEqual(['other\n\n', 'text\n'])
  })
})
