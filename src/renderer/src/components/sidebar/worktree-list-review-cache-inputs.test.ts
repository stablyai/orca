import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { FolderWorkspace } from '../../../../shared/types'
import {
  EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS,
  selectWorktreeListReviewCacheInputs,
  type WorktreeListReviewCacheState
} from './worktree-list-review-cache-inputs'

const EMPTY_STATE: WorktreeListReviewCacheState = {
  folderWorkspaces: [],
  hostedReviewCache: {},
  prCache: {},
  settings: null
}

const FOLDER_WORKSPACE = { id: 'folder-1' } as FolderWorkspace

describe('selectWorktreeListReviewCacheInputs', () => {
  it('ignores cache churn for ordinary cards outside PR-status grouping', () => {
    const first = selectWorktreeListReviewCacheInputs(EMPTY_STATE, 'repo', ['pr'])
    const afterCacheFill = selectWorktreeListReviewCacheInputs(
      {
        ...EMPTY_STATE,
        prCache: { branch: {} as never },
        hostedReviewCache: { branch: {} as never }
      },
      'repo',
      ['pr']
    )

    expect(first).toBe(EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS)
    expect(afterCacheFill).toBe(EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS)
    expect(shallow(first, afterCacheFill)).toBe(true)
  })

  it('keeps the PR cache live for PR-status grouping', () => {
    const prCache = { branch: {} as never }
    const selected = selectWorktreeListReviewCacheInputs(
      { ...EMPTY_STATE, prCache },
      'pr-status',
      []
    )

    expect(selected).toEqual({ prCache, hostedReviewCache: null })
  })

  it('keeps the PR cache live for legacy folder-card review displays', () => {
    const prCache = { branch: {} as never }
    const selected = selectWorktreeListReviewCacheInputs(
      { ...EMPTY_STATE, folderWorkspaces: [FOLDER_WORKSPACE], prCache },
      'repo',
      ['pr']
    )

    expect(selected).toEqual({ prCache, hostedReviewCache: null })
  })

  it('keeps both caches live for new-style folder status displays', () => {
    const prCache = { branch: {} as never }
    const hostedReviewCache = { branch: {} as never }
    const selected = selectWorktreeListReviewCacheInputs(
      {
        ...EMPTY_STATE,
        folderWorkspaces: [FOLDER_WORKSPACE],
        prCache,
        hostedReviewCache,
        settings: { experimentalNewWorktreeCardStyle: true } as never
      },
      'repo',
      ['status']
    )

    expect(selected).toEqual({ prCache, hostedReviewCache })
  })

  it('ignores both caches when folder cards hide review presentation', () => {
    const selected = selectWorktreeListReviewCacheInputs(
      { ...EMPTY_STATE, folderWorkspaces: [FOLDER_WORKSPACE] },
      'repo',
      ['comment']
    )

    expect(selected).toBe(EMPTY_WORKTREE_LIST_REVIEW_CACHE_INPUTS)
  })
})
