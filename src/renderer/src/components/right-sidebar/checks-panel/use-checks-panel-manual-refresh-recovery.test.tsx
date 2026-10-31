// @vitest-environment happy-dom

import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review-request-state'
import {
  hostedReviewForBranchReply,
  type HostedReviewForBranchArgs,
  type HostedReviewInfo
} from '../../../../../shared/hosted-review'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  __resetHostedReviewBranchCacheForTests,
  readHostedReviewBranchCache
} from '../../../../../main/source-control/hosted-review-branch-cache'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import HostedReviewActions from '../HostedReviewActions'
import { useChecksPanelManualRefresh } from './use-checks-panel-manual-refresh'

type RefreshInput = Parameters<typeof useChecksPanelManualRefresh>[0]

const FAILURE = "Couldn't refresh from GitLab. Try again."
const WITHIN_BACKOFF = new Date('2026-10-30T12:00:05Z')
// An hour on: past the host's failure backoff, so the next poll reaches the provider.
const AFTER_BACKOFF = new Date('2026-10-30T13:00:00Z')
const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const openMR: HostedReviewInfo & { provider: 'gitlab' } = {
  provider: 'gitlab',
  number: 7,
  title: 'MR',
  url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
  state: 'open',
  status: 'success',
  mergeable: 'UNKNOWN',
  updatedAt: '2026-10-30'
}

const original = useAppStore.getState()
let provider: () => Promise<HostedReviewInfo | null>
const lookup = vi.fn(() => provider())
// An older paired server drops reportReadOutcome and answers with the bare review.
let olderHost = false
// The paired runtime's request timeout: the click gives up while its host lookup runs on.
let clickTimesOut = false

function cacheKey(): string {
  return getHostedReviewCacheKey(
    repo.path,
    'main',
    useAppStore.getState().settings,
    repo.id,
    undefined,
    undefined,
    true
  )
}

function poll(): Promise<HostedReviewInfo | null> {
  // The selected card's background poll: forced, never a user refresh.
  return useAppStore.getState().fetchHostedReviewForBranch(repo.path, 'main', {
    force: true,
    repoId: repo.id,
    active: true,
    admissionTier: 'interactive',
    linkedGitLabMR: 7
  })
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

// The selected GitLab MR's panel, reading through the real store and host cache.
function gitLabInput(): RefreshInput {
  return {
    ...baseInput(),
    activeGitLabReview: openMR,
    activeReview: openMR,
    fetchHostedReviewForBranch: useAppStore.getState().fetchHostedReviewForBranch,
    hostedReview: openMR,
    hostedReviewCacheKey: cacheKey(),
    hostedReviewCreateProvider: 'gitlab',
    isGitLabReviewContext: true,
    linkedGitLabMR: 7,
    prNumber: null
  }
}

function renderPanel(input = gitLabInput()) {
  const shown: (string | null)[] = []
  const hook = renderHook(() => {
    const state = useChecksPanelManualRefresh(input)
    shown.push(state.manualRefreshError)
    return state
  })
  return { ...hook, shown, input }
}

// Seeds Open, then the provider goes down and the user's Refresh fails.
async function failedClick() {
  provider = async () => openMR
  await poll()
  provider = async () => {
    throw new Error('GitLab 503')
  }
  const panel = renderPanel()
  await act(async () => panel.result.current.handleRefresh())
  expect(panel.result.current.manualRefreshError).toBe(FAILURE)
  return panel
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'))
  olderHost = false
  clickTimesOut = false
  lookup.mockClear()
  vi.stubGlobal('api', {
    // The real host branch cache behind the IPC reply shape.
    hostedReview: {
      forBranch: async (args: HostedReviewForBranchArgs) => {
        const pending = readHostedReviewBranchCache(
          {
            repoPath: repo.path,
            executionHostId: 'local',
            branch: args.branch,
            linkedGitLabMR: args.linkedGitLabMR ?? null
          },
          { headOid: null, force: args.force, userRefresh: args.userRefresh, active: true },
          lookup
        )
        if (clickTimesOut && args.userRefresh) {
          void pending.catch(() => {})
          throw new Error('Request timed out')
        }
        const read = await pending
        return olderHost ? read.review : hostedReviewForBranchReply(read, args.reportReadOutcome)
      }
    }
  })
  useAppStore.setState({ repos: [repo], hostedReviewCache: {} })
})

afterEach(() => {
  cleanup()
  _clearHostedReviewRequestGenerationsForTest()
  __resetHostedReviewBranchCacheForTests()
  useAppStore.setState(original)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a failed Checks refresh clears only on a real provider read', () => {
  it.each([
    ['answers a poll from last-good during backoff', WITHIN_BACKOFF, 2],
    ['serves last-good while the provider still fails', AFTER_BACKOFF, 3]
  ])('keeps the failure when the host %s', async (_name, time, lookups) => {
    const panel = await failedClick()
    vi.setSystemTime(time)
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(lookups)
    expect(useAppStore.getState().hostedReviewCache[cacheKey()]?.data?.state).toBe('open')
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
  })

  it.each([
    ['identical data', openMR],
    ['a definitive no-review answer', null]
  ])('clears the failure when the provider recovers with %s', async (_name, answer) => {
    const panel = await failedClick()
    vi.setSystemTime(AFTER_BACKOFF)
    provider = async () => answer
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(useAppStore.getState().hostedReviewCache[cacheKey()]?.data).toEqual(answer)
    expect(panel.result.current.manualRefreshError).toBeNull()
  })

  it('never hides the failure while a retry that then fails is pending', async () => {
    const panel = await failedClick()
    let failRetry: (error: Error) => void = () => {}
    provider = () =>
      new Promise((_resolve, reject) => {
        failRetry = reject
      })
    let retry: Promise<void> = Promise.resolve()
    let polled: Promise<HostedReviewInfo | null> = Promise.resolve(null)
    await act(async () => {
      retry = panel.result.current.handleRefresh()
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(3))
      polled = poll()
    })
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
    await act(async () => {
      failRetry(new Error('GitLab 503'))
      await Promise.all([retry, polled])
    })
    expect(lookup).toHaveBeenCalledTimes(3)
    const afterFirstFailure = panel.shown.slice(panel.shown.indexOf(FAILURE))
    expect(afterFirstFailure.every((message) => message === FAILURE)).toBe(true)
  })

  it('keeps the failure when a later poll joins the timed-out click’s still-running lookup', async () => {
    provider = async () => openMR
    await poll()
    let finishClickLookup: (review: HostedReviewInfo) => void = () => {}
    provider = () =>
      new Promise((resolve) => {
        finishClickLookup = resolve
      })
    clickTimesOut = true
    const panel = renderPanel()
    await act(async () => panel.result.current.handleRefresh())
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
    await act(async () => {
      const polled = poll()
      finishClickLookup(openMR)
      await polled
    })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
    provider = async () => openMR
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(panel.result.current.manualRefreshError).toBeNull()
  })

  it('keeps the failure on an older host’s bare answer until a click succeeds', async () => {
    const panel = await failedClick()
    olderHost = true
    vi.setSystemTime(AFTER_BACKOFF)
    provider = async () => openMR
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
    await act(async () => panel.result.current.handleRefresh())
    expect(panel.result.current.manualRefreshError).toBeNull()
  })
})

describe('a Checks refresh click', () => {
  const foundPR: PRInfo = {
    number: 42,
    title: 'Current review',
    state: 'open',
    url: 'https://github.com/orca/app/pull/42',
    checksStatus: 'success',
    updatedAt: '2026-10-30',
    mergeable: 'MERGEABLE',
    headSha: 'head-2',
    prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
  }

  // Old path: every provider without a GitLab review went through the GitHub branch (PR lookup + lists cleared).
  it.each([
    ['unlinked Bitbucket', { hostedReviewCreateProvider: 'bitbucket' }, 'Bitbucket', false],
    ['linked Bitbucket', { linkedBitbucketPR: 3 }, 'Bitbucket', false],
    ['Azure DevOps', { linkedAzureDevOpsPR: 3 }, 'Azure DevOps', false],
    ['GitLab with no MR', { hostedReviewCreateProvider: 'gitlab' }, 'GitLab', false],
    ['GitLab with an MR', { linkedGitLabMR: 7, isGitLabReviewContext: true }, 'GitLab', false],
    ['GitHub', {}, null, true]
  ] as const)(
    '%s: routes the click to its provider and names it on a failure it owns',
    async (_name, overrides, providerName, readsGitHubPR) => {
      const input = Object.assign(baseInput(), overrides)
      input.fetchHostedReviewForBranch = vi.fn().mockRejectedValue(new Error('unreachable'))
      const { result } = renderPanel(input)
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
      // GitHub's refresh status comes from its PR read, not this card read.
      expect(result.current.manualRefreshError).toBe(
        providerName ? `Couldn't refresh from ${providerName}. Try again.` : null
      )
    }
  )

  it('on GitHub, a failed review-card read still refreshes the PR’s checks and comments', async () => {
    const input = baseInput()
    input.pr = foundPR
    input.fetchPRForBranch = vi.fn(async () => foundPR)
    input.fetchHostedReviewForBranch = vi.fn().mockRejectedValue(new Error('raw provider text'))
    const { result } = renderPanel(input)
    await act(async () => result.current.handleRefresh())
    expect(input.fetchPRChecks).toHaveBeenCalledTimes(1)
    expect(input.fetchPRComments).toHaveBeenCalledTimes(1)
    expect(result.current.manualRefreshError).toBeNull()
  })

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

  // Issue #14377: Refresh after a merge on GitLab must surface the workspace's delete action.
  it('publishes refreshed merged GitLab state to the existing workspace action', async () => {
    const review: HostedReviewInfo & { provider: 'gitlab' } = {
      ...openMR,
      mergeable: 'MERGEABLE'
    }
    const forBranch = vi
      .fn()
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce({ ...review, state: 'merged' })
    vi.stubGlobal('api', { hostedReview: { forBranch } })
    const input = baseInput()
    input.fetchHostedReviewForBranch = useAppStore.getState().fetchHostedReviewForBranch
    input.activeGitLabReview = review
    input.activeReview = review
    input.isGitLabReviewContext = true
    const worktree: Worktree = {
      id: 'worktree-1',
      repoId: repo.id,
      path: '/workspace/worktree',
      branch: 'main',
      isMainWorktree: false,
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
    await input.fetchHostedReviewForBranch(repo.path, 'main', { repoId: repo.id })
    function Probe() {
      const data = useAppStore((state) => Object.values(state.hostedReviewCache)[0]?.data)
      const { handleRefresh } = useChecksPanelManualRefresh(input)
      return (
        <>
          <button onClick={() => void handleRefresh()}>Refresh metadata</button>
          {data && (
            <HostedReviewActions
              review={data}
              repo={repo}
              worktree={worktree}
              onRefreshReview={handleRefresh}
            />
          )}
        </>
      )
    }
    render(<Probe />)
    expect(screen.queryByRole('button', { name: 'Delete Workspace' })).toBeNull()
    await act(async () => screen.getByRole('button', { name: 'Refresh metadata' }).click())
    expect(screen.getByRole('button', { name: 'Delete Workspace' })).toBeTruthy()
    expect(input.fetchGitLabDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mrNumberOverride: 7 })
    )
    expect(forBranch).toHaveBeenLastCalledWith(expect.objectContaining({ userRefresh: true }))
  })
})
