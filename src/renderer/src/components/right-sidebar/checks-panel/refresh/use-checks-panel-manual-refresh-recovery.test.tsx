// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { useChecksPanelManualRefresh } from './use-checks-panel-manual-refresh'

type RefreshInput = Parameters<typeof useChecksPanelManualRefresh>[0]
const FAILURE = "Couldn't refresh from GitLab. Try again."

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
function baseInput(): RefreshInput {
  return {
    activeConnectionId: null,
    activeGitLabReview: null,
    activeReview: null,
    activeWorktreeId: null,
    activeWorktreePath: null,
    activeWorktreePushTarget: null,
    asyncResultKeyRef: { current: 'cache::main::42' },
    branch: 'main',
    expireGitHubPRRefreshState: vi.fn(),
    fallbackGitHubPRNumber: null,
    fetchGitLabDetails: vi.fn(),
    fetchHostedReviewForBranch: vi.fn(async () => null),
    fetchPRChecks: vi.fn(async () => []),
    fetchPRComments: vi.fn(async () => []),
    fetchPRForBranch: vi.fn(async () => null),
    gitStatusSnapshot: null,
    hostedReview: null,
    hostedReviewCacheKey: 'hosted-review-key',
    hostedReviewCreateProvider: 'github',
    isCurrentAsyncResult: () => true,
    isFolder: false,
    isGitLabReviewContext: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: null,
    linkedPR: null,
    ownerCopyHostId: null,
    ownerTarget: { kind: 'local' },
    panelContextKey: 'ctx',
    panelContextKeyRef: { current: 'ctx' },
    pollIntervalRef: { current: 30_000 },
    pr: null,
    prCacheKey: 'cache',
    prNumber: 42,
    prevChecksRef: { current: '' },
    refreshInFlightRef: { current: false },
    refreshRequestKeyRef: { current: '' },
    repo,
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    setEligibilityRefreshNonce: vi.fn(),
    setGitStatusSnapshot: vi.fn(),
    setIsRefreshing: vi.fn(),
    updateWorktreeGitIdentity: vi.fn()
  }
}

function renderPanel(input: RefreshInput) {
  const shown: (string | null)[] = []
  const hook = renderHook(() => {
    const state = useChecksPanelManualRefresh(input)
    shown.push(state.manualRefreshError)
    return state
  })
  return { ...hook, shown, input }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a Checks refresh click', () => {
  it('names GitLab without its raw text, clears on a context change, and ignores the old context’s late failure', async () => {
    const input = baseInput()
    input.isGitLabReviewContext = true
    input.linkedGitLabMR = 7
    input.fetchHostedReviewForBranch = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw secret provider text'))
    const { result, rerender } = renderPanel(input)
    await act(async () => {
      await expect(result.current.handleRefresh()).resolves.toBeUndefined()
    })
    expect(input.refreshInFlightRef.current).toBe(false)
    expect(result.current.manualRefreshError).toBe(FAILURE)
    expect(JSON.stringify(result.current)).not.toContain('raw secret')

    const late = Promise.withResolvers<HostedReviewInfo | null>()
    input.fetchHostedReviewForBranch = vi.fn(() => late.promise)
    rerender()
    let old: Promise<void> = Promise.resolve()
    act(() => {
      old = result.current.handleRefresh()
    })
    expect(result.current.manualRefreshError).toBe(FAILURE)
    input.panelContextKey = 'new-context'
    input.panelContextKeyRef.current = 'new-context'
    rerender()
    expect(result.current.manualRefreshError).toBeNull()
    await act(async () => {
      late.reject(new Error('late failure'))
      await old
    })
    expect(result.current.manualRefreshError).toBeNull()
  })
})
