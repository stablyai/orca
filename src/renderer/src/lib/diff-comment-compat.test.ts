import { describe, expect, it } from 'vitest'
import type { DiffComment, PRComment } from '../../../shared/types'
import type { AppState } from '../store/types'
import {
  combineDiffComments,
  getDiffCommentLineLabel,
  getDiffCommentSource,
  isDiffComment,
  isMarkdownComment,
  prCommentToDecoratedDiffComment,
  prCommentsToDecoratedDiffComments,
  getPRInlineCommentsFromStore,
  selectRawPRCommentsFromStore
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

    it('filters out comments without path or line number', () => {
      const comments: PRComment[] = [
        mockPRComment,
        { ...mockPRComment, id: 456, path: undefined },
        { ...mockPRComment, id: 789, line: undefined }
      ]

      const mapped = prCommentsToDecoratedDiffComments(
        comments,
        'src/components/button.tsx',
        'wt-1'
      )
      expect(mapped).toHaveLength(1)
      expect(mapped[0].id).toBe('pr-123')
    })

    it('handles empty comment array', () => {
      const mapped = prCommentsToDecoratedDiffComments([], 'src/components/button.tsx', 'wt-1')
      expect(mapped).toHaveLength(0)
    })

    it('filters comments by file path', () => {
      const comments: PRComment[] = [
        mockPRComment,
        { ...mockPRComment, id: 456, path: 'src/other/file.ts' },
        { ...mockPRComment, id: 789, path: 'src/components/button.tsx' }
      ]

      const mapped = prCommentsToDecoratedDiffComments(
        comments,
        'src/components/button.tsx',
        'wt-1'
      )
      expect(mapped).toHaveLength(2)
      expect(mapped[0].id).toBe('pr-123')
      expect(mapped[1].id).toBe('pr-789')
    })

    it('transforms individual PR comment to decorated format', () => {
      const comment: PRComment = {
        id: 123,
        author: 'bunny',
        authorAvatarUrl: 'avatar',
        body: 'Review comment',
        createdAt: '2026-07-16T12:00:00Z',
        url: 'https://example.com',
        path: 'src/file.ts',
        line: 10,
        startLine: 5
      }

      const decorated = prCommentToDecoratedDiffComment(comment, 'wt-1')
      expect(decorated).not.toBeNull()
      expect(decorated?.id).toBe('pr-123')
      expect(decorated?.worktreeId).toBe('wt-1')
      expect(decorated?.filePath).toBe('src/file.ts')
      expect(decorated?.lineNumber).toBe(10)
      expect(decorated?.startLine).toBe(5)
      expect(decorated?.body).toBe('Review comment')
      expect(decorated?.author).toBe('bunny')
      expect(decorated?.authorAvatarUrl).toBe('avatar')
      expect(decorated?.url).toBe('https://example.com')
      expect(decorated?.canDelete).toBe(false)
      expect(decorated?.canEdit).toBe(false)
      expect(decorated?.source).toBe('diff')
      expect(decorated?.side).toBe('modified')
    })

    it('returns null for PR comment without path', () => {
      const comment: PRComment = {
        id: 123,
        author: 'bunny',
        authorAvatarUrl: 'avatar',
        body: 'Review comment',
        createdAt: '2026-07-16T12:00:00Z',
        url: 'url',
        line: 10
      }

      const decorated = prCommentToDecoratedDiffComment(comment, 'wt-1')
      expect(decorated).toBeNull()
    })

    it('returns null for PR comment without line number', () => {
      const comment: PRComment = {
        id: 123,
        author: 'bunny',
        authorAvatarUrl: 'avatar',
        body: 'Review comment',
        createdAt: '2026-07-16T12:00:00Z',
        url: 'url',
        path: 'src/file.ts'
      }

      const decorated = prCommentToDecoratedDiffComment(comment, 'wt-1')
      expect(decorated).toBeNull()
    })

    it('combines local and PR comments', () => {
      const localComments: DiffComment[] = [
        makeComment({ id: 'local-1', lineNumber: 5 }),
        makeComment({ id: 'local-2', lineNumber: 10 })
      ]

      const prComments: PRComment[] = [
        { ...mockPRComment, id: 456 },
        { ...mockPRComment, id: 789 }
      ]

      const decoratedPR = prCommentsToDecoratedDiffComments(
        prComments,
        'src/components/button.tsx',
        'wt-1'
      )
      const combined = combineDiffComments(localComments, decoratedPR)

      expect(combined).toHaveLength(4)
      expect(combined[0].id).toBe('local-1')
      expect(combined[1].id).toBe('local-2')
      expect(combined[2].id).toBe('pr-456')
      expect(combined[3].id).toBe('pr-789')
    })

    it('handles empty arrays when combining comments', () => {
      const combined1 = combineDiffComments([], [])
      expect(combined1).toHaveLength(0)

      const localComment = makeComment({ id: 'local-1' })
      const combined2 = combineDiffComments([localComment], [])
      expect(combined2).toHaveLength(1)
      expect(combined2[0].id).toBe('local-1')

      const prComment = prCommentToDecoratedDiffComment(mockPRComment, 'wt-1')
      const combined3 = combineDiffComments([], prComment ? [prComment] : [])
      expect(combined3).toHaveLength(1)
      expect(combined3[0].id).toBe('pr-123')
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

    it('returns empty array when worktree is not found', () => {
      const state = {
        getKnownWorktreeById: () => undefined,
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      const retrieved = getPRInlineCommentsFromStore(state, 'wt-1', 'src/components/button.tsx')
      expect(retrieved).toHaveLength(0)
    })

    it('returns empty array when worktreeId is undefined', () => {
      const state = {
        getKnownWorktreeById: () => ({ repoId: 'test', linkedPR: 12 }),
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      const retrieved = getPRInlineCommentsFromStore(state, undefined, 'src/components/button.tsx')
      expect(retrieved).toHaveLength(0)
    })

    it('returns empty array when no linked PR is found', () => {
      const state = {
        getKnownWorktreeById: () => ({
          repoId: 'stablyai/orca',
          branch: 'feat/test',
          linkedPR: undefined
        }),
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      const retrieved = getPRInlineCommentsFromStore(state, 'wt-1', 'src/components/button.tsx')
      expect(retrieved).toHaveLength(0)
    })

    it('looks up PR from cache when linkedPR is not set but branch exists', () => {
      const state = {
        getKnownWorktreeById: () => ({
          repoId: 'stablyai/orca',
          branch: 'feat/test',
          linkedPR: undefined
        }),
        prCache: {
          'stablyai/orca::feat/test': {
            data: { number: 42 },
            fetchedAt: Date.now()
          }
        },
        commentsCache: {
          'ssh:host-1::stablyai/orca::pr-comments::stablyai/orca::42': {
            data: [mockPRComment],
            fetchedAt: Date.now()
          }
        }
      } as unknown as AppState

      const retrieved = getPRInlineCommentsFromStore(state, 'wt-1', 'src/components/button.tsx')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0].id).toBe('pr-123')
    })

    it('selects raw PR comments from store for a worktree', () => {
      const state = {
        getKnownWorktreeById: (id: string) => ({
          id,
          repoId: 'stablyai/orca',
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

      const retrieved = selectRawPRCommentsFromStore(state, 'wt-1')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0].id).toBe(123)
    })

    it('matches PR comment cache repo IDs by delimiter-bounded segments to avoid substring hits', () => {
      const state = {
        getKnownWorktreeById: (id: string) => ({
          id,
          repoId: 'repo-1',
          linkedPR: 12
        }),
        prCache: {},
        commentsCache: {
          'scope::repo-10::pr-comments::repo-10::12': { data: [mockPRComment] },
          'scope::repo-1::pr-comments::repo-1::12': { data: [] }
        }
      } as unknown as AppState

      expect(selectRawPRCommentsFromStore(state, 'wt-1')).toEqual([])
    })

    it('reuses empty PR comment array references', () => {
      const state = {
        getKnownWorktreeById: () => undefined,
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      expect(selectRawPRCommentsFromStore(state, 'wt-1')).toBe(
        selectRawPRCommentsFromStore(state, 'wt-1')
      )
    })

    it('selectRawPRCommentsFromStore returns empty array for missing worktree', () => {
      const state = {
        getKnownWorktreeById: () => undefined,
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      const retrieved = selectRawPRCommentsFromStore(state, 'wt-1')
      expect(retrieved).toHaveLength(0)
    })

    it('selectRawPRCommentsFromStore returns empty array for undefined worktreeId', () => {
      const state = {
        getKnownWorktreeById: () => ({ repoId: 'test' }),
        prCache: {},
        commentsCache: {}
      } as unknown as AppState

      const retrieved = selectRawPRCommentsFromStore(state, undefined)
      expect(retrieved).toHaveLength(0)
    })
  })
})
