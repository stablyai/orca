import type { MarkdownLexerConfiguration, MarkdownTokenizer } from '@tiptap/core'
import type { Tokens } from 'marked'
import { OrderedList } from '@tiptap/extension-list'
import TaskList from '@tiptap/extension-task-list'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichMarkdownOrderedList } from './rich-markdown-ordered-list'
import { RichMarkdownTaskList } from './rich-markdown-task-list'

const lexer: MarkdownLexerConfiguration = {
  inlineTokens: (src) => [{ type: 'text', raw: src, text: src }],
  blockTokens: (src) => [{ type: 'paragraph', raw: src, text: src }]
}

function getTokenizer(extension: typeof OrderedList | typeof TaskList): MarkdownTokenizer {
  return extension.config.markdownTokenizer as MarkdownTokenizer
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rich markdown list tokenizers', () => {
  it.each([
    ['ordered', RichMarkdownOrderedList, OrderedList],
    ['task', RichMarkdownTaskList, TaskList]
  ] as const)('skips the %s base tokenizer for nonmatching source', (_name, guarded, base) => {
    const baseTokenizer = getTokenizer(base)
    const tokenize = vi.spyOn(baseTokenizer, 'tokenize')
    const source = `# Heading\n\n${'Paragraph content.\n'.repeat(10_000)}`

    expect(getTokenizer(guarded).tokenize(source, [], lexer)).toBeUndefined()
    expect(tokenize).not.toHaveBeenCalled()
  })

  it('calls the task base tokenizer once for matching source', () => {
    const tokenize = vi.spyOn(getTokenizer(TaskList), 'tokenize')

    expect(
      getTokenizer(RichMarkdownTaskList).tokenize('- [x] done\n- [ ] todo\n', [], lexer)
    ).toBeTruthy()
    expect(tokenize).toHaveBeenCalledOnce()
  })

  it('tokenizes a matching ordered source without the base tokenizer', () => {
    const tokenize = vi.spyOn(getTokenizer(OrderedList), 'tokenize')

    expect(
      getTokenizer(RichMarkdownOrderedList).tokenize('3. third\n4. fourth\n', [], lexer)
    ).toBeTruthy()
    expect(tokenize).not.toHaveBeenCalled()
  })

  it('preserves nested ordered-list tokens', () => {
    const source = '3. parent\n   1. child\n   2. child two\n4. sibling\n'

    const token = getTokenizer(RichMarkdownOrderedList).tokenize(source, [], lexer) as Tokens.List

    expect(token.start).toBe(3)
    expect(token.items).toHaveLength(2)
    const [parent, sibling] = token.items
    expect(parent.raw).toBe('3. parent')
    expect(sibling.raw).toBe('4. sibling\n')
    const nested = parent.tokens?.find((child) => child.type === 'list') as Tokens.List
    expect(nested.start).toBe(1)
    expect(nested.items.map((item) => item.raw)).toEqual(['   1. child', '   2. child two'])
  })

  it('preserves nested task-list tokens', () => {
    const source = '- [ ] parent\n  - [x] child\n- [x] sibling\n'

    expect(getTokenizer(RichMarkdownTaskList).tokenize(source, [], lexer)).toEqual(
      getTokenizer(TaskList).tokenize(source, [], lexer)
    )
  })
})
