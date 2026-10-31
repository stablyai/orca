// @vitest-environment happy-dom

import { act, cleanup, renderHook, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { Worktree } from '../../../../../shared/worktree/types'
import HostedReviewActions from '../HostedReviewActions'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review-request-state'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

const refresh = { calls: [] as string[] }

import { useChecksPanelManualRefresh } from './use-checks-panel-manual-refresh'

type RefreshInput = Parameters<typeof useChecksPanelManualRefresh>[0]

function makeInput(): RefreshInput {
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
    fetchHostedReviewForBranch: vi.fn(async () => {
      refresh.calls.push('hosted-review')
      return null
    }),
    fetchPRChecks: vi.fn(async () => {
      refresh.calls.push('checks')
      return []
    }),
    fetchPRComments: vi.fn(async () => {
      refresh.calls.push('comments')
      return []
    }),
    fetchPRForBranch: vi.fn(async () => {
      refresh.calls.push('review')
      return null
    }),
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
    panelContextKey: 'repo-1::worktree-1::main',
    panelContextKeyRef: { current: 'repo-1::worktree-1::main' },
    pollIntervalRef: { current: 30_000 },
    pr: null,
    prCacheKey: 'cache',
    prNumber: 42,
    prevChecksRef: { current: '' },
    refreshInFlightRef: { current: false },
    refreshRequestKeyRef: { current: '' },
    repo: {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    },
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    setEligibilityRefreshNonce: vi.fn(),
    setGitStatusSnapshot: vi.fn(),
    setIsRefreshing: vi.fn((loading) => {
      refresh.calls.push(`refreshing:${String(loading)}`)
    }),
    updateWorktreeGitIdentity: vi.fn()
  }
}

afterEach(async () => {
  await i18n.changeLanguage('en')
  _clearHostedReviewRequestGenerationsForTest()
  cleanup()
  refresh.calls.length = 0
})

describe('useChecksPanelManualRefresh ordering', () => {
  it('refreshes review identity before starting checks and comments, then clears loading', async () => {
    const refreshedPR = {
      number: 42,
      state: 'open',
      title: 'Current review',
      headSha: 'head-2',
      prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
    } as NonNullable<RefreshInput['pr']>
    const setChecksLoading: RefreshInput['setChecksLoading'] = vi.fn((loading) => {
      refresh.calls.push(`checks-loading:${String(loading)}`)
    })
    const setCommentsLoading: RefreshInput['setCommentsLoading'] = vi.fn((loading) => {
      refresh.calls.push(`comments-loading:${String(loading)}`)
    })
    const input = makeInput()
    input.pr = refreshedPR
    input.fetchPRForBranch = vi.fn(async () => {
      refresh.calls.push('review')
      return refreshedPR
    })
    input.setChecksLoading = setChecksLoading
    input.setCommentsLoading = setCommentsLoading

    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(refresh.calls).toEqual([
      'refreshing:true',
      'review',
      'hosted-review',
      'checks',
      'checks-loading:true',
      'comments-loading:true',
      'comments',
      'checks-loading:false',
      'comments-loading:false',
      'refreshing:false'
    ])
    expect(input.fetchPRForBranch).toHaveBeenCalledWith('/workspace/repo', 'main', {
      force: true,
      repoId: 'repo-1',
      worktreeId: undefined,
      linkedPRNumber: null,
      fallbackPRNumber: null,
      reason: 'manual'
    })
  })
  it('consumes metadata failure once, retains content while retrying, and clears only on current success', async () => {
    const input = makeInput()
    input.isGitLabReviewContext = true
    input.linkedGitLabMR = 7
    input.fetchHostedReviewForBranch = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw secret provider text'))
      .mockResolvedValueOnce(null)
    const { result, rerender } = renderHook(() => useChecksPanelManualRefresh(input))
    await act(async () => {
      await expect(result.current.handleRefresh()).resolves.toBeUndefined()
    })
    expect(input.fetchHostedReviewForBranch).toHaveBeenCalledWith(
      '/workspace/repo',
      'main',
      expect.objectContaining({ userRefresh: true, force: true })
    )
    expect(input.fetchGitLabDetails).not.toHaveBeenCalled()
    expect(input.setChecks).not.toHaveBeenCalled()
    expect(input.setComments).not.toHaveBeenCalled()
    expect(input.refreshInFlightRef.current).toBe(false)
    expect(result.current).toMatchObject({
      manualRefreshError: expect.stringMatching(/GitLab.*try.*again/i)
    })
    expect(JSON.stringify(result.current)).not.toContain('raw secret')
    await act(async () => result.current.handleRefresh())
    expect(result.current).toMatchObject({ manualRefreshError: null })
    input.fetchHostedReviewForBranch = vi.fn().mockRejectedValueOnce(new Error('failure'))
    rerender()
    await act(async () => result.current.handleRefresh())
    input.panelContextKey = 'another-branch'
    input.panelContextKeyRef.current = 'another-branch'
    rerender()
    expect(result.current).toMatchObject({ manualRefreshError: null })
  })

  it('keeps a retry failure visible until success and ignores a late rejected request from the previous context', async () => {
    const input = makeInput()
    input.isGitLabReviewContext = true
    i18n.addResource(
      'es',
      'translation',
      'auto.components.right.sidebar.github.refresh.error.copy.manual_provider',
      'No se pudo actualizar desde {{provider}}. Vuelve a intentarlo.'
    )
    await i18n.changeLanguage('es')
    input.fetchHostedReviewForBranch = vi.fn().mockRejectedValueOnce(new Error('offline'))
    const { result, rerender } = renderHook(() => useChecksPanelManualRefresh(input))
    await act(async () => result.current.handleRefresh())
    expect(result.current.manualRefreshError).toBe(
      'No se pudo actualizar desde GitLab. Vuelve a intentarlo.'
    )
    let rejectOld: (error: Error) => void = () => {}
    input.fetchHostedReviewForBranch = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject
        })
    )
    rerender()
    let old: Promise<void> = Promise.resolve()
    act(() => {
      old = result.current.handleRefresh()
    })
    expect(result.current.manualRefreshError).toBe(
      'No se pudo actualizar desde GitLab. Vuelve a intentarlo.'
    )
    input.panelContextKey = 'new-context'
    input.panelContextKeyRef.current = 'new-context'
    input.refreshInFlightRef.current = false
    input.refreshRequestKeyRef.current = null
    input.fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    rerender()
    await act(async () => result.current.handleRefresh())
    await act(async () => {
      rejectOld(new Error('late failure'))
      await old
    })
    expect(result.current.manualRefreshError).toBeNull()
  })

  it.each([false, true])(
    'publishes refreshed merged GitLab state to the existing workspace action (main=%s)',
    async (isMainWorktree) => {
      const input = makeInput()
      const review: HostedReviewInfo = {
        provider: 'gitlab',
        number: 7,
        title: 'MR',
        url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
        state: 'open',
        status: 'success',
        mergeable: 'MERGEABLE',
        updatedAt: '2026-10-30'
      }
      const original = useAppStore.getState()
      const api = window.api
      const lookup = vi
        .fn()
        .mockResolvedValueOnce(review)
        .mockResolvedValueOnce({ ...review, state: 'merged' })
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: { hostedReview: { forBranch: lookup } }
      })
      useAppStore.setState({ repos: [input.repo!], hostedReviewCache: {} })
      input.fetchHostedReviewForBranch = useAppStore.getState().fetchHostedReviewForBranch
      input.activeGitLabReview = review
      input.activeReview = review
      input.isGitLabReviewContext = true
      input.isFolder = isMainWorktree
      const worktree: Worktree = {
        id: 'worktree-1',
        repoId: input.repo!.id,
        path: '/workspace/worktree',
        branch: 'main',
        isMainWorktree,
        head: 'head',
        isBare: false,
        displayName: 'workspace',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
      try {
        await input.fetchHostedReviewForBranch(input.repo!.path, 'main', { repoId: input.repo!.id })
        function Probe() {
          const data = useAppStore((state) => Object.values(state.hostedReviewCache)[0]?.data)
          const { handleRefresh } = useChecksPanelManualRefresh(input)
          return (
            <>
              <button onClick={() => void handleRefresh()}>Refresh metadata</button>
              {data && (
                <HostedReviewActions
                  review={data}
                  repo={input.repo!}
                  worktree={worktree}
                  onRefreshReview={handleRefresh}
                />
              )}
            </>
          )
        }
        render(<Probe />)
        const label = isMainWorktree ? 'Remove Project' : 'Delete Workspace'
        expect(screen.queryByRole('button', { name: label })).toBeNull()
        await act(async () => screen.getByRole('button', { name: 'Refresh metadata' }).click())
        expect(screen.getByRole('button', { name: label })).toBeTruthy()
        expect(input.fetchGitLabDetails).toHaveBeenCalledWith(
          expect.objectContaining({ mrNumberOverride: 7 })
        )
        expect(lookup).toHaveBeenLastCalledWith(expect.objectContaining({ userRefresh: true }))
      } finally {
        cleanup()
        Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
        useAppStore.setState(original)
      }
    }
  )
})

describe('useChecksPanelManualRefresh failures', () => {
  const refreshedPR = {
    number: 42,
    state: 'open',
    title: 'Current review',
    headSha: 'head-2',
    prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
  } as NonNullable<RefreshInput['pr']>
  const gitLabReview: HostedReviewInfo = {
    provider: 'gitlab',
    number: 7,
    title: 'MR',
    url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
    state: 'merged',
    status: 'success',
    mergeable: 'UNKNOWN',
    updatedAt: '2026-10-30'
  }

  it('drops a manual failure once a newer read for the panel lands, but not for an older one', async () => {
    const original = useAppStore.getState()
    const input = makeInput()
    input.isGitLabReviewContext = true
    input.linkedGitLabMR = 7
    input.fetchHostedReviewForBranch = vi.fn().mockRejectedValueOnce(new Error('offline'))
    const entry = (fetchedAt: number) => ({
      hostedReviewCache: { 'hosted-review-key': { data: gitLabReview, fetchedAt } }
    })
    try {
      useAppStore.setState(entry(Date.now() - 1_000))
      const { result } = renderHook(() => useChecksPanelManualRefresh(input))
      await act(async () => result.current.handleRefresh())
      expect(result.current.manualRefreshError).toBe("Couldn't refresh from GitLab. Try again.")
      // A background poll succeeding after the failed click replaces the failure, as a newer success would.
      act(() => useAppStore.setState(entry(Date.now() + 1_000)))
      expect(result.current.manualRefreshError).toBeNull()
    } finally {
      useAppStore.setState(original)
    }
  })

  it('still refreshes GitHub checks and comments when only the hosted-review read fails', async () => {
    const input = makeInput()
    input.pr = refreshedPR
    input.fetchPRForBranch = vi.fn(async () => refreshedPR)
    input.fetchHostedReviewForBranch = vi.fn().mockRejectedValue(new Error('raw provider text'))
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))
    await act(async () => result.current.handleRefresh())
    expect(input.fetchPRChecks).toHaveBeenCalledTimes(1)
    expect(input.fetchPRComments).toHaveBeenCalledTimes(1)
    expect(result.current.manualRefreshError).toBe("Couldn't refresh from GitHub. Try again.")
  })

  // Old path: every provider without a GitLab review went through the GitHub branch (PR lookup + lists cleared).
  it.each([
    ['unlinked Bitbucket', { hostedReviewCreateProvider: 'bitbucket' }, 'Bitbucket', false],
    ['linked Bitbucket', { linkedBitbucketPR: 3 }, 'Bitbucket', false],
    ['Azure DevOps', { linkedAzureDevOpsPR: 3 }, 'Azure DevOps', false],
    ['unlinked Gitea', { hostedReviewCreateProvider: 'gitea' }, 'Gitea', false],
    ['GitLab with no MR', { hostedReviewCreateProvider: 'gitlab' }, 'GitLab', false],
    ['GitLab with an MR', { linkedGitLabMR: 7, isGitLabReviewContext: true }, 'GitLab', false],
    ['GitHub', {}, 'GitHub', true]
  ] as const)(
    '%s: routes the click to its provider and names it on failure',
    async (_name, overrides, providerName, readsGitHubPR) => {
      const input = Object.assign(makeInput(), overrides)
      input.fetchHostedReviewForBranch = vi.fn().mockRejectedValue(new Error('unreachable'))
      const { result } = renderHook(() => useChecksPanelManualRefresh(input))
      await act(async () => result.current.handleRefresh())
      expect(input.fetchHostedReviewForBranch).toHaveBeenCalledWith(
        '/workspace/repo',
        'main',
        expect.objectContaining({ force: true, userRefresh: true })
      )
      expect(vi.mocked(input.fetchPRForBranch).mock.calls.length > 0).toBe(readsGitHubPR)
      expect(input.fetchGitLabDetails).not.toHaveBeenCalled()
      // Only the GitHub path owns checks and comments; it clears them when no PR is found.
      expect(vi.mocked(input.setChecks).mock.calls.length > 0).toBe(readsGitHubPR)
      expect(vi.mocked(input.setComments).mock.calls.length > 0).toBe(readsGitHubPR)
      expect(result.current.manualRefreshError).toBe(
        `Couldn't refresh from ${providerName}. Try again.`
      )
    }
  )
})
