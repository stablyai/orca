import { Table } from '@tiptap/extension-table'
import { afterEach, expect, it, vi } from 'vitest'
import { RichMarkdownTable } from './rich-markdown-table'

afterEach(() => vi.restoreAllMocks())

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
