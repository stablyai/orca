import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { routeListingBranchSwitchesThroughGitIdentity } from './worktree-listing-branch-switch'

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: 'repo1',
    path: '/path/wt',
    head: 'abc123',
    branch: 'refs/heads/feature-one',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature-one',
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
    ...overrides
  }
}

const hasLinkedPR = (worktree: Worktree): boolean => worktree.linkedPR != null
const matchesAnyHost = (): boolean => true

describe('routeListingBranchSwitchesThroughGitIdentity', () => {
  it('routes a listing-observed branch switch through updateWorktreeGitIdentity', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: current,
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'def456'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).toHaveBeenCalledTimes(1)
    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo1::/path/wt1', {
      head: 'def456',
      branch: 'refs/heads/feature-two'
    })
  })

  it('does nothing when the branch is unchanged', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: current,
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-one',
          head: 'def456'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('skips entries without branch-scoped review context (stale-refetch protection)', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: null })]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: current,
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'def456'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('skips incoming worktrees with no current entry (cold hydration)', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [makeWorktree({ id: 'repo1::/path/other', linkedPR: 101 })]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: current,
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'def456'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('does nothing when there is no current list', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: undefined,
      current: undefined,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'def456'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('maps an empty listing branch to the explicit detached-HEAD signal', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: current,
      current,
      incoming: [makeWorktree({ id: 'repo1::/path/wt1', branch: '', head: 'def456' })],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo1::/path/wt1', {
      head: 'def456',
      branch: null
    })
  })

  it('rejects a listing response when the branch changed again after the request started', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const current = [
      makeWorktree({
        id: 'repo1::/path/wt1',
        branch: 'refs/heads/feature-three',
        head: 'newest-head',
        linkedPR: 303
      })
    ]

    const reconciled = routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-one',
          linkedPR: 101
        })
      ],
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'stale-head'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
    expect(reconciled).toEqual(current)
  })

  it('preserves a manual relink made while the listing request was in flight', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const requestStarted = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 101 })]
    const current = [makeWorktree({ id: 'repo1::/path/wt1', linkedPR: 303 })]

    const reconciled = routeListingBranchSwitchesThroughGitIdentity({
      requestStarted,
      current,
      incoming: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          branch: 'refs/heads/feature-two',
          head: 'stale-head',
          linkedPR: 101
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
    expect(reconciled).toEqual(current)
  })

  it('fails closed when the same worktree id belongs to multiple execution hosts', () => {
    const updateWorktreeGitIdentity = vi.fn()
    const requestStarted = [
      makeWorktree({ id: 'repo1::/same/path', hostId: 'local', linkedPR: 101 }),
      makeWorktree({ id: 'repo1::/same/path', hostId: 'ssh:ssh-1', linkedPR: 202 })
    ]

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted,
      current: requestStarted,
      incoming: [
        makeWorktree({
          id: 'repo1::/same/path',
          branch: 'refs/heads/feature-two',
          head: 'remote-head'
        })
      ],
      matchesRefreshHost: matchesAnyHost,
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('does not route an old-host response through a row now owned by another host', () => {
    const updateWorktreeGitIdentity = vi.fn()

    routeListingBranchSwitchesThroughGitIdentity({
      requestStarted: [
        makeWorktree({ id: 'repo1::/same/path', hostId: 'ssh:ssh-1', linkedPR: 101 })
      ],
      current: [makeWorktree({ id: 'repo1::/same/path', hostId: 'ssh:ssh-2', linkedPR: 202 })],
      incoming: [
        makeWorktree({
          id: 'repo1::/same/path',
          hostId: 'ssh:ssh-1',
          branch: 'refs/heads/feature-two',
          head: 'old-host-head'
        })
      ],
      matchesRefreshHost: (worktree) => worktree.hostId === 'ssh:ssh-1',
      hasBranchScopedReviewContext: hasLinkedPR,
      updateWorktreeGitIdentity
    })

    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })
})
