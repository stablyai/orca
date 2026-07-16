import { describe, expect, it } from 'vitest'
import type { DiffComment, PRComment } from '../../../shared/types'
import type { AppState } from '../store/types'
import {
  getDiffCommentLineLabel,
  getDiffCommentSource,
  isDiffComment,
  isMarkdownComment,
  prCommentsToDecoratedDiffComments,
  getPRInlineCommentsFromStore
} from './diff-comment-compat'

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'c1',
    worktreeId: 'wt1',
    filePath: 'README.md',
    lineNumber: 4,
    body: 'note',
    createdAt: 0,
    side: 'modified',
    ...overrides
  }
}

describe('diff comment compatibility helpers', () => {
  it('routes legacy comments with no source as diff comments', () => {
    const comment = makeComment()
    expect(getDiffCommentSource(comment)).toBe('diff')
    expect(isDiffComment(comment)).toBe(true)
    expect(isMarkdownComment(comment)).toBe(false)
  })

  it('routes markdown comments by explicit source', () => {
    const comment = makeComment({ source: 'markdown' })
    expect(getDiffCommentSource(comment)).toBe('markdown')
    expect(isMarkdownComment(comment)).toBe(true)
    expect(isDiffComment(comment)).toBe(false)
  })

  it('formats compact and full range labels', () => {
    const comment = makeComment({ startLine: 2, lineNumber: 4 })
    expect(getDiffCommentLineLabel(comment)).toBe('Lines 2-4')
    expect(getDiffCommentLineLabel(comment, true)).toBe('L2-L4')
  })

  describe('PR comment mapping and normalization', () => {
    const mockPRComment: PRComment = {
      id: 123,
      author: 'bunny',
      authorAvatarUrl: 'avatar',
      body: 'Review comment',
      createdAt: '2026-07-16T12:00:00Z',
      url: 'url',
      path: 'src/components/button.tsx',
      line: 10
    }

    it('maps raw PR comment to decorated comment when path matches with different casing/slashes', () => {
      const comments = [mockPRComment]
      
      // Exact match
      let mapped = prCommentsToDecoratedDiffComments(comments, 'src/components/button.tsx', 'wt-1')
      expect(mapped).toHaveLength(1)
      expect(mapped[0].body).toBe('Review comment')
      expect(mapped[0].lineNumber).toBe(10)

      // Windows slashes
      mapped = prCommentsToDecoratedDiffComments(comments, 'src\\components\\button.tsx', 'wt-1')
      expect(mapped).toHaveLength(1)

      // Leading slash
      mapped = prCommentsToDecoratedDiffComments(comments, '/src/components/button.tsx', 'wt-1')
      expect(mapped).toHaveLength(1)

      // Casing difference
      mapped = prCommentsToDecoratedDiffComments(comments, 'SRC/Components/Button.tsx', 'wt-1')
      expect(mapped).toHaveLength(1)
    })

    it('retrieves PR comments dynamically matching cache keys in store', () => {
      const state = {
        getKnownWorktreeById: (id: string) => ({
          id,
          repoId: 'stablyai/orca',
          path: '/path/to/wt',
          branch: 'feat/test',
          linkedPR: 12
        }),
        prCache: {},
        commentsCache: {
          'ssh:host-1::stablyai/orca::pr-comments::stablyai/orca::12': {
            data: [mockPRComment],
            fetchedAt: Date.now()
          }
        }
      } as unknown as AppState

      const retrieved = getPRInlineCommentsFromStore(state, 'wt-1', 'src/components/button.tsx')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0].id).toBe('pr-123')
    })
  })
})
