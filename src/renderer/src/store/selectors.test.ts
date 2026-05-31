import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { getAllWorktreesFromState, getWorktreeMapFromState } from './selectors'

function makeWorktree(args: { id: string; repoId: string; displayName: string }): Worktree {
  return {
    id: args.id,
    repoId: args.repoId,
    displayName: args.displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: args.id,
    head: 'HEAD',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

describe('store selectors', () => {
  it('deduplicates cached worktree snapshots without changing reference reuse', () => {
    const first = makeWorktree({ id: 'wt-1', repoId: 'repo-1', displayName: 'first' })
    const second = makeWorktree({ id: 'wt-2', repoId: 'repo-1', displayName: 'second' })
    const replacement = makeWorktree({
      id: 'wt-1',
      repoId: 'repo-2',
      displayName: 'replacement'
    })
    const state = {
      worktreesByRepo: {
        'repo-1': [first, second],
        'repo-2': [replacement]
      }
    }

    const allWorktrees = getAllWorktreesFromState(state)
    const worktreeMap = getWorktreeMapFromState(state)

    expect(allWorktrees).toEqual([replacement, second])
    expect(worktreeMap.get('wt-1')).toBe(replacement)
    expect(getAllWorktreesFromState(state)).toBe(allWorktrees)
    expect(getWorktreeMapFromState(state)).toBe(worktreeMap)
  })
})
