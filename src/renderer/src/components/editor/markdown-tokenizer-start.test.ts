import { expect, it, vi } from 'vitest'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'
import { createOrcaDetailsExtensions } from './rich-markdown-details-extension'
import {
  createMarkdownTokenizerStart,
  createMarkdownTokenizerStartCursor,
  registerMarkdownTokenizerStart
} from './markdown-tokenizer-start'

it.each([
  'x\n:::detailsSummary',
  'x\r:::detailsSummary',
  'x\u2028:::detailsSummary',
  'x\u2029:::detailsSummary',
  'x:::detailsSummary\n:::detailsSummary',
  'ordinary text'
])('matches the upstream multiline directive start: %j', (source) => {
  expect(createMarkdownTokenizerStart(':::detailsSummary', true)(source)).toBe(
    source.match(/^:::detailsSummary/m)?.index ?? -1
  )
})

it('does not search each remaining suffix for an absent marker', () => {
  const marked = createTiptapMarkedFacade()
  const start = createMarkdownTokenizerStart('MARKER')
  marked.use({
    extensions: [{ name: 'marker', level: 'block', start, tokenizer: () => undefined }]
  })
  const includes = vi.spyOn(String.prototype, 'includes')
  const indexOf = vi.spyOn(String.prototype, 'indexOf')
  try {
    marked.lexer('Prose\n\n'.repeat(1000))
    expect(includes.mock.calls.filter(([value]) => value === 'MARKER')).toHaveLength(1)
    expect(indexOf.mock.calls.filter(([value]) => value === 'MARKER')).toHaveLength(0)
  } finally {
    includes.mockRestore()
    indexOf.mockRestore()
  }
})

it('restores searches for nested generated input and later parses', () => {
  const marked = createTiptapMarkedFacade()
  const start = createMarkdownTokenizerStart('MARKER')
  marked.use({
    extensions: [
      {
        name: 'marker',
        level: 'block',
        start,
        tokenizer(source) {
          return source.startsWith('MARKER')
            ? { type: 'marker', raw: 'MARKER', text: 'found' }
            : undefined
        }
      },
      {
        name: 'wrapper',
        level: 'block',
        tokenizer(source) {
          if (!source.startsWith('WRAPPER')) {
            return undefined
          }
          return {
            type: 'wrapper',
            raw: 'WRAPPER',
            tokens: this.lexer.blockTokens('prose\nMARKER')
          }
        }
      }
    ]
  })
  const nested = marked.lexer('WRAPPER')
  expect(nested[0]).toMatchObject({
    type: 'wrapper',
    tokens: [{ type: 'paragraph' }, { type: 'marker' }]
  })
  expect(marked.lexer('prose\nMARKER').map((token) => token.type)).toEqual(['paragraph', 'marker'])
  expect(createTiptapMarkedFacade().lexer('MARKER')[0].type).toBe('paragraph')
})

it('skips custom searches when their required marker is absent', () => {
  const marked = createTiptapMarkedFacade()
  const search = vi.fn((source: string) => source.search(/<details\b/i))
  marked.use({
    extensions: [
      {
        name: 'details',
        level: 'block',
        start: registerMarkdownTokenizerStart('<', search),
        tokenizer: () => undefined
      }
    ]
  })
  marked.lexer('Prose\n\n'.repeat(1000))
  expect(search).not.toHaveBeenCalled()
  marked.lexer('Prose\n<DETAILS>')
  expect(search).toHaveReturnedWith(5)
})

it('recognizes a suffix-start directive skipped by an earlier line-start search', () => {
  const marked = createTiptapMarkedFacade()
  marked.use({
    extensions: [
      {
        name: 'directive',
        level: 'block',
        start: createMarkdownTokenizerStart(':::x', true),
        tokenizer: (source) =>
          source.startsWith(':::x') ? { type: 'directive', raw: ':::x', text: 'found' } : undefined
      }
    ]
  })
  expect(marked.lexer('Prose\n\nx:::x\n\n:::x').map(({ type, raw }) => ({ type, raw }))).toEqual([
    { type: 'paragraph', raw: 'Prose' },
    { type: 'space', raw: '\n\n' },
    { type: 'paragraph', raw: 'x' },
    { type: 'directive', raw: ':::x' },
    { type: 'space', raw: '\n\n' },
    { type: 'directive', raw: ':::x' }
  ])
})

function getDetailsTokenizerStart() {
  const tokenizer = createOrcaDetailsExtensions()[0].config.markdownTokenizer
  if (!tokenizer || typeof tokenizer === 'function' || typeof tokenizer.start !== 'function') {
    throw new Error('Details tokenizer must expose its start hint')
  }
  return tokenizer.start
}

it('rechecks details start hints when a suffix discards their lookbehind', () => {
  const start = createMarkdownTokenizerStartCursor(getDetailsTokenizerStart())
  const source = 'before\n   <details>\n\nnext\n<details>'
  expect([0, 7, 10, 26].map((offset) => start(source.slice(offset)))).toEqual([10, 19, 16, -1])
})
