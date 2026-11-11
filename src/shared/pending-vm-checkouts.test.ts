import { describe, expect, it } from 'vitest'
import { indexPendingVmCheckouts, isPendingVmCheckout } from './pending-vm-checkouts'
import { getEmptyProjectPlaceholderRepoIds } from './sidebar-list/empty-project-placeholder-repos'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'

describe('pending VM checkouts', () => {
  it('matches only the primary checkout at the pending repo and path', () => {
    const index = indexPendingVmCheckouts([{ repoId: 'vm', path: '/srv/repo/' }])
    expect(isPendingVmCheckout(index, { repoId: 'vm', path: '/srv/repo' })).toBe(true)
    expect(
      isPendingVmCheckout(index, { repoId: 'vm', path: '/srv/repo', isMainWorktree: false })
    ).toBe(false)
    expect(isPendingVmCheckout(index, { repoId: 'vm', path: '/srv/other' })).toBe(false)
    expect(isPendingVmCheckout(index, { repoId: 'local', path: '/srv/repo' })).toBe(false)
    expect(isPendingVmCheckout(index, { worktreeId: 'no-repo-fields' })).toBe(false)
  })

  it('draws no empty-project placeholder for a grouped VM project while its create is pending', () => {
    const repo: Repo = {
      id: 'vm',
      path: '/srv/repo',
      displayName: 'VM',
      badgeColor: '#000',
      addedAt: 1,
      projectGroupId: 'group-1'
    }
    const vmCheckout: Worktree = {
      id: 'vm::/srv/repo',
      repoId: 'vm',
      path: '/srv/repo',
      head: 'abc123',
      branch: 'refs/heads/task',
      isBare: false,
      isMainWorktree: true,
      displayName: 'task',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    }
    const args = {
      groupBy: 'repo' as const,
      repos: [repo],
      worktreesByRepo: { vm: [vmCheckout] },
      visibleWorktrees: [],
      filterRepoIds: []
    }
    expect(getEmptyProjectPlaceholderRepoIds(args)).toEqual(new Set(['local\0vm']))
    expect(
      getEmptyProjectPlaceholderRepoIds({ ...args, pendingVmRepoIds: new Set(['vm']) })
    ).toEqual(new Set())
  })
})
