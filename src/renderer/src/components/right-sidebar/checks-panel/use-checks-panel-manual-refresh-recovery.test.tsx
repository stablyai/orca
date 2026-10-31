// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { _clearHostedReviewRequestGenerationsForTest } from '@/store/slices/hosted-review-request-state'
import {
  hostedReviewForBranchReply,
  type HostedReviewForBranchArgs,
  type HostedReviewInfo
} from '../../../../../shared/hosted-review'
import {
  __resetHostedReviewBranchCacheForTests,
  readHostedReviewBranchCache
} from '../../../../../main/source-control/hosted-review-branch-cache'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

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

function renderPanel() {
  const input: RefreshInput = {
    activeConnectionId: null,
    activeGitLabReview: openMR,
    activeReview: openMR,
    activeWorktreeId: null,
    activeWorktreePath: null,
    activeWorktreePushTarget: null,
    asyncResultKeyRef: { current: 'x' },
    branch: 'main',
    expireGitHubPRRefreshState: vi.fn(),
    fallbackGitHubPRNumber: null,
    fetchGitLabDetails: vi.fn(),
    fetchHostedReviewForBranch: useAppStore.getState().fetchHostedReviewForBranch,
    fetchPRChecks: vi.fn(),
    fetchPRComments: vi.fn(),
    fetchPRForBranch: vi.fn(),
    gitStatusSnapshot: null,
    hostedReview: openMR,
    hostedReviewCacheKey: cacheKey(),
    hostedReviewCreateProvider: 'gitlab',
    isCurrentAsyncResult: () => true,
    isFolder: false,
    isGitLabReviewContext: true,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: 7,
    linkedPR: null,
    ownerCopyHostId: null,
    ownerTarget: { kind: 'local' },
    panelContextKey: 'ctx',
    panelContextKeyRef: { current: 'ctx' },
    pollIntervalRef: { current: 30_000 },
    pr: null,
    prCacheKey: 'cache',
    prNumber: null,
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
  const shown: (string | null)[] = []
  const hook = renderHook(() => {
    const state = useChecksPanelManualRefresh(input)
    shown.push(state.manualRefreshError)
    return state
  })
  return { ...hook, shown }
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
  it('keeps the failure when the host answers a poll from last-good during backoff', async () => {
    const panel = await failedClick()
    vi.setSystemTime(WITHIN_BACKOFF)
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().hostedReviewCache[cacheKey()]?.data?.state).toBe('open')
    expect(panel.result.current.manualRefreshError).toBe(FAILURE)
  })

  it('keeps the failure when the provider still fails and the host serves last-good', async () => {
    const panel = await failedClick()
    vi.setSystemTime(AFTER_BACKOFF)
    await act(async () => void (await poll()))
    expect(lookup).toHaveBeenCalledTimes(3)
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
