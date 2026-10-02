// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { useChecksPanelConflictRefresh } from './use-checks-panel-conflict-refresh'

type RefreshInput = Parameters<typeof useChecksPanelConflictRefresh>[0]

afterEach(cleanup)

function conflictingPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    title: 'Conflicting PR',
    state: 'open',
    url: 'https://github.com/acme/widgets/pull/42',
    checksStatus: 'pending',
    updatedAt: '2026-09-30T00:00:00Z',
    mergeable: 'CONFLICTING',
    ...overrides
  }
}

function makeInput(overrides: Partial<RefreshInput> = {}): RefreshInput {
  return {
    activeWorktreeId: 'worktree-1',
    branch: 'feature',
    conflictRefreshKeyRef: { current: null },
    fallbackGitHubPRNumber: null,
    fetchPRForBranch: vi.fn(async () => null),
    isFolder: false,
    linkedPR: 42,
    pr: conflictingPR(),
    prCacheKey: '/repo::feature',
    repo: { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '#000000', addedAt: 0 },
    ...overrides
  }
}

describe('useChecksPanelConflictRefresh', () => {
  it('force-refreshes a conflicting PR once per PR key, not on every rerender', () => {
    const input = makeInput()
    const { rerender } = renderHook((props: RefreshInput) => useChecksPanelConflictRefresh(props), {
      initialProps: input
    })
    rerender({ ...input, pr: conflictingPR({ updatedAt: '2026-09-30T00:01:00Z' }) })

    expect(input.fetchPRForBranch).toHaveBeenCalledTimes(1)
    expect(input.fetchPRForBranch).toHaveBeenCalledWith(
      '/repo',
      'feature',
      expect.objectContaining({ force: true, linkedPRNumber: 42, reason: 'active' })
    )
  })

  it('does not refresh a PR the host reports as mergeable', () => {
    const input = makeInput({ pr: conflictingPR({ mergeable: 'MERGEABLE' }) })
    renderHook(() => useChecksPanelConflictRefresh(input))

    expect(input.fetchPRForBranch).not.toHaveBeenCalled()
  })
})
