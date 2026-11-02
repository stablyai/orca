import type { MarkdownLexerConfiguration, MarkdownTokenizer } from '@tiptap/core'
import { OrderedList, TaskList } from '@tiptap/extension-list'
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
})
