import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../shared/types'
import { mapMarkdownCommentsToBlocks, type MarkdownCommentBlock } from './markdown-comment-blocks'

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    worktreeId: 'wt1',
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: 4,
    body: 'note',
    createdAt: 0,
    side: 'modified',
    ...overrides
  }
}

describe('mapMarkdownCommentsToBlocks', () => {
  it('maps comments to the rendered block that owns their anchor line', () => {
    const blocks: MarkdownCommentBlock[] = [
      { key: 'p:2-3', startLine: 2, endLine: 3 },
      { key: 'p:4-6', startLine: 4, endLine: 6 }
    ]
    const mapped = mapMarkdownCommentsToBlocks([makeComment({ id: 'a', lineNumber: 5 })], blocks)

    expect(mapped.byBlockKey.get('p:4-6')?.map((comment) => comment.id)).toEqual(['a'])
    expect(mapped.unresolved).toEqual([])
  })

  it('keeps comments without a rendered block unresolved for shelf fallback', () => {
    const blocks: MarkdownCommentBlock[] = [{ key: 'p:2-3', startLine: 2, endLine: 3 }]
    const mapped = mapMarkdownCommentsToBlocks(
      [makeComment({ id: 'stale', lineNumber: 20 })],
      blocks
    )

    expect(mapped.byBlockKey.size).toBe(0)
    expect(mapped.unresolved.map((comment) => comment.id)).toEqual(['stale'])
  })
})
