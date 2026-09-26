import type { MarkdownLexerConfiguration, MarkdownTokenizer } from '@tiptap/core'
import { Editor } from '@tiptap/core'
import type { Tokens } from 'marked'
import { OrderedList } from '@tiptap/extension-list'
import TaskList from '@tiptap/extension-task-list'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { RichMarkdownOrderedList } from './rich-markdown-ordered-list'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { RichMarkdownTaskList } from './rich-markdown-task-list'

const lexer: MarkdownLexerConfiguration = {
  inlineTokens: (src) => [{ type: 'text', raw: src, text: src }],
  blockTokens: (src) => [{ type: 'paragraph', raw: src, text: src }]
}

function getTokenizer(extension: typeof OrderedList | typeof TaskList): MarkdownTokenizer {
  return extension.config.markdownTokenizer as MarkdownTokenizer
}

/** Round-trips `source` through the full editor with `orderedList` swapped in. */
function roundTripWithOrderedList(orderedList: typeof OrderedList, source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const extensions = createRichMarkdownExtensions({ codec }).map((extension) =>
    extension.name === 'orderedList' ? orderedList : extension
  )
  const editor = new Editor({
    element: null,
    extensions,
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
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

  it.each([
    'a. first\nb. second',
    'I. first\nII. second',
    'A. upper\nB. two',
    'i. lower\nii. two',
    '1) paren\n2) two',
    '  3. indented',
    'a. outer\n   1. nested'
  ])('renders %j the same as the upstream ordered list', (source) => {
    // Why: the structural tokenizer emits a token shape of its own, so marker
    // handling is pinned by what reaches the document rather than by token fields.
    expect(roundTripWithOrderedList(RichMarkdownOrderedList, source)).toBe(
      roundTripWithOrderedList(OrderedList, source)
    )
  })

  it('keeps a numeric child nested under a non-numeric parent', () => {
    const source = 'a. outer\n   1. nested'
    expect(roundTripWithOrderedList(RichMarkdownOrderedList, source)).toBe(source)
  })

  it('does not advertise mid-paragraph numbers as list starts', () => {
    const start = getTokenizer(RichMarkdownOrderedList).start
    expect(typeof start).toBe('function')
    if (typeof start === 'function') {
      expect(start('(216) 555-1234')).toBe(-1)
    }
  })

  it('preserves nested task-list tokens', () => {
    const source = '- [ ] parent\n  - [x] child\n- [x] sibling\n'

    expect(getTokenizer(RichMarkdownTaskList).tokenize(source, [], lexer)).toEqual(
      getTokenizer(TaskList).tokenize(source, [], lexer)
    )
  })
})
