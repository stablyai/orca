import type { MarkdownLexerConfiguration, MarkdownTokenizer } from '@tiptap/core'
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

  it.each([
    ['ordered', RichMarkdownOrderedList, OrderedList, '3. third\n4. fourth\n'],
    ['task', RichMarkdownTaskList, TaskList, '- [x] done\n- [ ] todo\n']
  ] as const)(
    'calls the %s base tokenizer once for matching source',
    (_name, guarded, base, source) => {
      const tokenize = vi.spyOn(getTokenizer(base), 'tokenize')

      expect(getTokenizer(guarded).tokenize(source, [], lexer)).toBeTruthy()
      expect(tokenize).toHaveBeenCalledOnce()
    }
  )

  it('preserves nested ordered-list tokens', () => {
    const source = '3. parent\n   1. child\n   2. child two\n4. sibling\n'

    expect(getTokenizer(RichMarkdownOrderedList).tokenize(source, [], lexer)).toEqual(
      getTokenizer(OrderedList).tokenize(source, [], lexer)
    )
  })

  it('preserves nested task-list tokens', () => {
    const source = '- [ ] parent\n  - [x] child\n- [x] sibling\n'

    expect(getTokenizer(RichMarkdownTaskList).tokenize(source, [], lexer)).toEqual(
      getTokenizer(TaskList).tokenize(source, [], lexer)
    )
  })
})
