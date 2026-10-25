// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useChecksPanelForegroundEffects } from './use-checks-panel-foreground-effects'

function model() {
  return {
    activeWorktree: makeWorktree({ id: 'worktree', repoId: 'repo', branch: 'main', head: 'head' }),
    activeWorktreeId: 'worktree',
    branch: 'main',
    enqueueGitHubPRRefresh: vi.fn(),
    fetchHostedReviewForBranch: vi.fn().mockResolvedValue(null),
    foregroundedUnrenderedReviewKeyRef: { current: null },
    isPanelVisible: true,
    panelVisibleSinceRef: { current: 1 },
    repo: {
      id: 'repo',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '',
      addedAt: 1
    },
    repoConnectionId: null,
    runtimeEnvironmentId: null,
    setGitStatusRefreshNonce: vi.fn(),
    fallbackGitHubPRNumber: null,
    isFolder: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: null,
    linkedPR: null,
    prCachedHasPR: true,
    foregroundReviewEvidenceKey: null,
    isGitHubReviewContext: true,
    prFetchedAt: 1
  }
}
beforeEach(() => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('checks foreground discovery', () => {
  it('leaves initial and HEAD metadata discovery to the central owners', () => {
    const input = model()
    const hook = renderHook(({ input }) => useChecksPanelForegroundEffects(input), {
      initialProps: { input }
    })
    expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
    hook.rerender({
      input: {
        ...input,
        repo: { ...input.repo }
      }
    })
    expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
    expect(input.enqueueGitHubPRRefresh).not.toHaveBeenCalled()
    hook.rerender({
      input: {
        ...input,
        activeWorktree: { ...input.activeWorktree, head: 'new-head' }
      }
    })
    expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
    expect(input.enqueueGitHubPRRefresh).not.toHaveBeenCalled()
  })

  it('does no metadata discovery from hidden windows or folder panels', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const input = model()
    const hook = renderHook(({ input }) => useChecksPanelForegroundEffects(input), {
      initialProps: { input }
    })
    expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
    expect(input.enqueueGitHubPRRefresh).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    hook.rerender({ input: { ...input, isFolder: true } })
    expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
  })

  it('retains runtime SSH status polling while stopping hidden work', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const input = { ...model(), runtimeEnvironmentId: 'owner', repoConnectionId: 'ssh' }
    try {
      renderHook(() => useChecksPanelForegroundEffects(input))
      await act(async () => vi.advanceTimersByTimeAsync(3_000))
      expect(input.setGitStatusRefreshNonce).toHaveBeenCalledOnce()
      expect(input.fetchHostedReviewForBranch).not.toHaveBeenCalled()
      expect(input.enqueueGitHubPRRefresh).not.toHaveBeenCalled()
      visibility.mockReturnValue('hidden')
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      expect(input.setGitStatusRefreshNonce).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
