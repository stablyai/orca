import { describe, expect, it } from 'vitest'
import type { DiffComment, Worktree } from '../../../shared/types'
import type { AppState } from './types'
import {
  selectWorktreeDiffComments,
  selectWorktreeDiffCommentsOrEmpty
} from './worktree-diff-comments-selector'
import { getIndexedWorktreeById } from './worktree-repo-index'

function makeComment(id: string): DiffComment {
  return {
    id,
    worktreeId: 'worktree-99-99',
    filePath: 'src/index.ts',
    lineNumber: 1,
    body: 'Review note',
    createdAt: 1,
    updatedAt: 1,
    source: 'diff',
    side: 'modified'
  }
}

describe('selectWorktreeDiffComments', () => {
  it('indexes one immutable worktree snapshot across retained editor selectors', () => {
    let worktreeIdReads = 0
    const targetWorktreeId = 'worktree-99-99'
    const comments = [makeComment('comment-1')]
    const worktreesByRepo: AppState['worktreesByRepo'] = {}

    for (let repoIndex = 0; repoIndex < 100; repoIndex += 1) {
      const repoId = `repo-${repoIndex}`
      worktreesByRepo[repoId] = Array.from({ length: 100 }, (_, worktreeIndex) => {
        const worktreeId = `worktree-${repoIndex}-${worktreeIndex}`
        const worktree = {
          repoId,
          path: `/${repoId}/${worktreeId}`,
          ...(worktreeId === targetWorktreeId ? { diffComments: comments } : {})
        } as Worktree
        Object.defineProperty(worktree, 'id', {
          enumerable: true,
          get: () => {
            worktreeIdReads += 1
            return worktreeId
          }
        })
        return worktree
      })
    }

    for (let write = 0; write < 200; write += 1) {
      // Model all seven comment selectors plus the rich-editor path selector.
      expect(selectWorktreeDiffComments({ worktreesByRepo }, targetWorktreeId)).toBe(comments)
      expect(selectWorktreeDiffComments({ worktreesByRepo }, targetWorktreeId)).toBe(comments)
      expect(selectWorktreeDiffComments({ worktreesByRepo }, targetWorktreeId)).toBe(comments)
      expect(selectWorktreeDiffComments({ worktreesByRepo }, targetWorktreeId)).toBe(comments)
      expect(selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo }, targetWorktreeId)).toBe(
        comments
      )
      expect(selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo }, targetWorktreeId)).toBe(
        comments
      )
      expect(selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo }, targetWorktreeId)).toBe(
        comments
      )
      expect(getIndexedWorktreeById(worktreesByRepo, targetWorktreeId)?.path).toBe(
        '/repo-99/worktree-99-99'
      )
    }

    expect(worktreeIdReads).toBe(10_000)
  })

  it('reads a replacement worktree snapshot and handles an absent id', () => {
    const firstComments = [makeComment('comment-1')]
    const nextComments = [makeComment('comment-2')]
    const first = { repo: [{ id: 'worktree-1', diffComments: firstComments } as Worktree] }
    const next = { repo: [{ id: 'worktree-1', diffComments: nextComments } as Worktree] }

    expect(selectWorktreeDiffComments({ worktreesByRepo: first }, 'worktree-1')).toBe(firstComments)
    expect(selectWorktreeDiffComments({ worktreesByRepo: next }, 'worktree-1')).toBe(nextComments)
    expect(selectWorktreeDiffComments({ worktreesByRepo: next }, null)).toBeUndefined()
    expect(selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo: next }, null)).toBe(
      selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo: next }, undefined)
    )
  })
})
