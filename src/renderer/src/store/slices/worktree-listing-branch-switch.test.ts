import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { routeListingBranchSwitchesThroughGitIdentity } from './worktree-listing-branch-switch'

const restoredStub: Worktree = {
  id: 'repo-1::/srv/app/feature',
  repoId: 'repo-1',
  hostId: 'runtime:env-1',
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  path: '/srv/app/feature',
  head: '',
  branch: '',
  isBare: false,
  isMainWorktree: false
}

describe('routeListingBranchSwitchesThroughGitIdentity', () => {
  it('lets the first listing replace a restored stub that git status filled in meanwhile', () => {
    const stubWithGitStatus = { ...restoredStub, head: 'abc123', branch: 'refs/heads/feature' }
    const listed: Worktree = {
      ...stubWithGitStatus,
      runtimeOwnerEnvironmentId: 'env-1',
      instanceId: 'instance-1'
    }

    const result = routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: [restoredStub],
      current: [stubWithGitStatus],
      incoming: [listed],
      matchesRefreshHost: () => true,
      hasBranchScopedReviewContext: () => false,
      updateWorktreeGitIdentity: vi.fn()
    })

    expect(result[0]?.instanceId).toBe('instance-1')
  })
})
