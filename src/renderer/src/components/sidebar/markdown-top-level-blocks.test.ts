import { describe, expect, it } from 'vitest'
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

/** Feeds the source a few characters at a time, as a stream delivers it. */
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
  it('cuts at top-level blocks and loses none of the source', () => {
    const blocks = cut(REPLY)
    expect(blocks.join('')).toBe(REPLY)
    expect(blocks.map((block) => block.trim().split('\n')[0])).toEqual([
      'Here is the plan.',
      '## Steps',
      '- first item',
      '1. one',
      'A loose list follows.',
      '1. first',
      '> a quote',
      '```ts',
      'Intro to the table',
      '| a | b |',
      'Setext title',
      'Closing words with `code` and **bold**.'
    ])
  })

  it.each([1, 3, 7])('reaches the same cut when streamed %i characters at a time', (step) => {
    expect(streamed(REPLY, step)).toEqual(cut(REPLY))
  })

  it('keeps Windows line endings inside their blocks', () => {
    const source = 'one\r\n\r\ntwo\r\n\r\n- three\r\n'
    expect(cut(source)).toEqual(['one\r\n\r\n', 'two\r\n\r\n', '- three\r\n'])
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

  it('still cuts a document whose only HTML is a tag that holds nothing', () => {
    expect(cut('| a |\n| - |\n| one<br>two |\n\nAfter.\n')).toHaveLength(2)
  })

  it('starts over when the source is replaced rather than appended to', () => {
    const first = splitMarkdownTopLevelBlocks('one\n\ntwo\n', null)
    expect(cut('other\n\ntext\n', first)).toEqual(['other\n\n', 'text\n'])
  })
})
