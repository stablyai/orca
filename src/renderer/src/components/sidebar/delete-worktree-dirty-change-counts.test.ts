import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { orderDeleteWorktreeStatusHydrationTargets } from './delete-worktree-dirty-change-counts'

function worktree(id: string, hostId?: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/${id}`,
    displayName: id,
    branch: 'refs/heads/main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(hostId ? { hostId } : {})
  }
}

describe('delete-worktree status hydration ordering', () => {
  it('orders the active target first, visible targets next, and descendants last', () => {
    const targets = [
      worktree('descendant-a'),
      worktree('visible-a'),
      worktree('active', 'ssh:builder'),
      worktree('visible-b'),
      worktree('descendant-b')
    ]

    expect(
      orderDeleteWorktreeStatusHydrationTargets({
        targets,
        visibleTargets: [targets[1], targets[3]],
        activeWorktreeId: 'active',
        activeExecutionHostId: 'ssh:builder'
      }).map((target) => target.id)
    ).toEqual(['active', 'visible-a', 'visible-b', 'descendant-a', 'descendant-b'])
  })
})
