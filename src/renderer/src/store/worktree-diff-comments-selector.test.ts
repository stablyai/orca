import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../shared/diff-comment-types'

import type { AppState } from './types'
import { makeWorktree } from './slices/worktrees-slice-test-fixtures'
import {
  selectWorktreeDiffComments,
  selectWorktreeDiffCommentsOrEmpty
} from './worktree-diff-comments-selector'
import { createDiffCommentViewSelector } from './diff-comment-owner'

const TARGET = 'repo-9::/w/target'

function makeComment(id: string): DiffComment {
  return {
    id,
    worktreeId: TARGET,
    filePath: 'src/index.ts',
    lineNumber: 1,
    body: 'Review note',
    createdAt: 1,
    updatedAt: 1,
    source: 'diff',
    side: 'modified'
  }
}

/** Mounted note consumers re-run their selector on every store write; count row reads per write. */
function measureViewSelectors(rowsPerRepo: number) {
  let idReads = 0
  const comments = [makeComment('comment-1')]
  const worktreesByRepo: AppState['worktreesByRepo'] = {}
  for (let repoIndex = 0; repoIndex < 10; repoIndex += 1) {
    const repoId = `repo-${repoIndex}`
    worktreesByRepo[repoId] = Array.from({ length: rowsPerRepo }, (_, index) => {
      const id = repoIndex === 9 && index === 0 ? TARGET : `${repoId}::/w/${index}`
      const worktree = makeWorktree({
        id,
        repoId,
        path: id.slice(repoId.length + 2),
        hostId: 'local',
        ...(id === TARGET ? { diffComments: comments } : {})
      })
      Object.defineProperty(worktree, 'id', {
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        }
      })
      return worktree
    })
  }
  const consumers = Array.from({ length: 8 }, () => createDiffCommentViewSelector())
  let state: Pick<
    AppState,
    'worktreesByRepo' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  > = { worktreesByRepo, activeWorktreeId: TARGET, activeWorkspaceExecutionHostId: 'local' }
  const views = consumers.map((select) => select(state, TARGET))
  expect(views[0].comments).toBe(comments)
  expect(views[0].owner).toEqual({
    kind: 'worktree',
    worktreeId: TARGET,
    authority: { endpoint: { kind: 'self' }, at: 'local' }
  })

  idReads = 0
  for (let write = 0; write < 200; write += 1) {
    state = { ...state }
    consumers.forEach((select, index) => expect(select(state, TARGET)).toBe(views[index]))
  }
  const unrelatedWriteReads = idReads

  // Another repo's listing changes: every consumer re-resolves once, and keeps its view.
  idReads = 0
  state = { ...state, worktreesByRepo: { ...worktreesByRepo, 'repo-0': [] } }
  consumers.forEach((select, index) => expect(select(state, TARGET)).toBe(views[index]))
  return { unrelatedWriteReads, catalogWriteReads: idReads }
}

describe('note owner view selectors', () => {
  it('do no row work on writes that change no ownership input, at any catalog size', () => {
    const small = measureViewSelectors(100)
    const large = measureViewSelectors(1000)

    expect(small.unrelatedWriteReads).toBe(0)
    expect(large.unrelatedWriteReads).toBe(0)
    // A listing change costs one pass per consumer over the open repo plus one shared index build.
    expect(small.catalogWriteReads).toBeLessThanOrEqual(8 * 100 + 9 * 100)
    expect(large.catalogWriteReads).toBeLessThanOrEqual(8 * 1000 + 9 * 1000)
  })
})

describe('selectWorktreeDiffComments', () => {
  it('reads a replacement worktree snapshot and handles an absent id', () => {
    const firstComments = [makeComment('comment-1')]
    const nextComments = [makeComment('comment-2')]
    const first = {
      'repo-9': [makeWorktree({ id: TARGET, repoId: 'repo-9', diffComments: firstComments })]
    }
    const next = {
      'repo-9': [makeWorktree({ id: TARGET, repoId: 'repo-9', diffComments: nextComments })]
    }

    expect(selectWorktreeDiffComments({ worktreesByRepo: first }, TARGET)).toBe(firstComments)
    expect(selectWorktreeDiffComments({ worktreesByRepo: next }, TARGET)).toBe(nextComments)
    expect(selectWorktreeDiffComments({ worktreesByRepo: next }, null)).toBeUndefined()
    expect(selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo: next }, null)).toBe(
      selectWorktreeDiffCommentsOrEmpty({ worktreesByRepo: next }, undefined)
    )
  })
})
