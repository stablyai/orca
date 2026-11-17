import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { routeListingBranchSwitchesThroughGitIdentity } from './worktree-listing-branch-switch'

function row(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo-1::/work/batfish-2',
    repoId: 'repo-1',
    path: '/work/batfish-2',
    head: 'aaa',
    branch: 'refs/heads/me/batfish-2',
    isBare: false,
    isMainWorktree: false,
    displayName: 'batfish-2',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function route(current: Worktree, incoming: Worktree): Worktree {
  return routeListingBranchSwitchesThroughGitIdentity({
    requestStarted: [row({})],
    current: [current],
    incoming: [incoming],
    refreshHostId: 'local',
    matchesRefreshHost: () => true,
    hasBranchScopedReviewContext: () => false,
    updateWorktreeGitIdentity: () => {}
  })[0]
}

describe('routeListingBranchSwitchesThroughGitIdentity', () => {
  const renamedBranch = 'refs/heads/me/triage-assigned-issues-prs'
  const incoming = row({
    head: 'bbb',
    branch: renamedBranch,
    displayName: 'Triage assigned issues prs',
    displayNameMode: 'fixed',
    comment: 'from listing'
  })

  it('adopts the listing pinned title over a kept creature name', () => {
    const current = row({ head: 'ccc', branch: renamedBranch, comment: 'in memory' })

    expect(route(current, incoming)).toEqual({
      ...current,
      displayName: 'Triage assigned issues prs',
      displayNameMode: 'fixed'
    })
  })

  it('keeps a kept title that is not a creature name', () => {
    const current = row({
      head: 'ccc',
      branch: renamedBranch,
      displayName: 'My own title',
      comment: 'in memory'
    })

    expect(route(current, incoming)).toBe(current)
  })
})
