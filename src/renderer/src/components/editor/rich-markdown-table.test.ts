import { Table } from '@tiptap/extension-table'
import { afterEach, expect, it, vi } from 'vitest'
import { RichMarkdownTable } from './rich-markdown-table'

afterEach(() => vi.restoreAllMocks())

it.each([
  '',
  'prose',
  '| A | B |\n| --- | :---: |\n| a | b |',
  'A | B\n--- | ---\na | b',
  '| A |\nnot a separator\n',
  'one\n\n| A |\n| --- |',
  '| A |\r\n| --- |\r\n',
  '| A |\n| - |',
  '| A |\n| : |',
  `| A |\n| - |\n${'prose\n'.repeat(10_000)}`
])('matches the upstream table detector: %j', (source) => {
  const base = Table.config.markdownTokenizer
  const guarded = RichMarkdownTable.config.markdownTokenizer
  if (
    !base ||
    typeof base === 'function' ||
    typeof base.start !== 'function' ||
    !guarded ||
    typeof guarded === 'function' ||
    typeof guarded.start !== 'function'
  ) {
    throw new Error('Table tokenizer contract changed')
  }
  expect(guarded.start(source)).toBe(base.start(source))
})

it('only passes the first two lines to the upstream detector', () => {
  const base = Table.config.markdownTokenizer
  const guarded = RichMarkdownTable.config.markdownTokenizer
  if (
    !base ||
    typeof base === 'function' ||
    typeof base.start !== 'function' ||
    !guarded ||
    typeof guarded === 'function' ||
    typeof guarded.start !== 'function'
  ) {
    throw new Error('Table tokenizer contract changed')
  }
  const original = base.start
  const start = vi.fn(original)
  base.start = start
  try {
    guarded.start(`first\nsecond\n${'rest\n'.repeat(10_000)}`)
    expect(start).toHaveBeenCalledExactlyOnceWith('first\nsecond')
  } finally {
    base.start = original
  }
})
