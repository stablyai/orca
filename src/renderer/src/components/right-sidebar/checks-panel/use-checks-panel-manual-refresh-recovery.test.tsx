// @vitest-environment happy-dom

import type { SetStateAction } from 'react'
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
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import { selectChecksPanelReview } from '../checks-panel-review'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
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
import { useChecksPanelPolling } from './use-checks-panel-polling'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'

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

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/12',
    checksStatus: 'pending',
    updatedAt: '2026-05-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'head-sha',
    ...overrides
  }
}

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

it.each(['merged', 'open'] as const)(
  'a GitHub click uses the post-click %s PR head',
  async (state) => {
    const old = Promise.withResolvers<{ kind: 'found'; pr: PRInfo; fetchedAt: number }>()
    const open = makePR({ number: 42, headSha: 'head-a' })
    const merged = makePR({ number: 42, state, headSha: 'head-b' })
    const refreshPRNow = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ kind: 'found', pr: merged, fetchedAt: 2 })
    vi.stubGlobal('api', { gh: { refreshPRNow } })
    const key = getGitHubPRCacheKey(
      repo.path,
      repo.id,
      'main',
      useAppStore.getState().settings,
      undefined,
      undefined,
      true
    )
    useAppStore.setState({ prCache: { [key]: { data: open, fetchedAt: 1 } }, prRefreshStates: {} })
    const fetchPR = useAppStore.getState().fetchPRForBranch
    const before = fetchPR(repo.path, 'main', { force: true, reason: 'visible', repoId: repo.id })
    const input = { ...baseInput(), pr: open, prCacheKey: key, fetchPRForBranch: fetchPR }
    input.fetchPRChecks = vi.fn(async () => [
      { name: 'build', status: 'completed' as const, conclusion: 'success' as const, url: null }
    ])
    const panel = renderPanel(input)
    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = panel.result.current.handleRefresh()
    })
    // Let main's pre-click response finish too, so a buggy joined click completes with head-a.
    old.resolve({ kind: 'found', pr: open, fetchedAt: 1 })
    await act(async () => {
      await Promise.all([before, click])
    })
    expect(input.fetchPRChecks).toHaveBeenCalledWith(
      repo.path,
      42,
      'main',
      'head-b',
      merged.prRepo,
      expect.anything()
    )
    const pr = useAppStore.getState().prCache[key]?.data
    const review = selectChecksPanelReview({
      pr,
      hostedReview: null,
      linkedPR: null,
      suppressedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    expect(review?.state).toBe(state)
    expect(input.refreshInFlightRef.current).toBe(false)
  }
)

it('a failed GitHub click without cached metadata is not a successful no-PR answer', async () => {
  vi.stubGlobal('api', {
    gh: { refreshPRNow: vi.fn().mockRejectedValue(new Error('transport unavailable')) }
  })
  useAppStore.setState({ prCache: {}, prRefreshStates: {} })
  const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
  const input = {
    ...baseInput(),
    prCacheKey: key,
    fetchPRForBranch: useAppStore.getState().fetchPRForBranch
  }
  const panel = renderPanel(input)
  await act(async () => panel.result.current.handleRefresh())
  expect(useAppStore.getState().prCache[key]).toBeUndefined()
  expect(useAppStore.getState().prRefreshStates[key]).toMatchObject({
    status: 'error',
    errorType: 'unknown'
  })
  expect(input.setChecks).not.toHaveBeenCalled()
  expect(input.setComments).not.toHaveBeenCalled()
  expect(panel.result.current.manualRefreshError).toBeNull()
  expect(input.refreshInFlightRef.current).toBe(false)
})

it.each([false, true])(
  "a click's checks and comments replace pre-click reads on screen (old reply first: %s)",
  async (oldFirst) => {
    const pr = makePR({ number: 42, headSha: 'head-a' })
    const running: PRCheckDetail[] = [
      { name: 'build', status: 'in_progress', conclusion: null, url: null }
    ]
    const passed: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ]
    const comment = (body: string): PRComment => ({
      id: 1,
      author: 'octocat',
      authorAvatarUrl: '',
      body,
      createdAt: '2026-10-30T12:00:00Z',
      url: ''
    })
    const oldChecks = Promise.withResolvers<PRCheckDetail[]>()
    const newChecks = Promise.withResolvers<PRCheckDetail[]>()
    const oldComments = Promise.withResolvers<PRComment[]>()
    const newComments = Promise.withResolvers<PRComment[]>()
    const gh = {
      refreshPRNow: vi.fn(async () => ({ kind: 'found', pr, fetchedAt: Date.now() })),
      prChecks: vi.fn().mockReturnValueOnce(oldChecks.promise).mockReturnValue(newChecks.promise),
      prComments: vi
        .fn()
        .mockReturnValueOnce(oldComments.promise)
        .mockReturnValue(newComments.promise)
    }
    vi.stubGlobal('api', { gh })
    const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
    useAppStore.setState({ prCache: { [key]: { data: pr, fetchedAt: 1 } }, prRefreshStates: {} })
    const store = useAppStore.getState()
    const shown: { checks: PRCheckDetail[]; comments: PRComment[]; checksLoading: boolean } = {
      checks: [],
      comments: [],
      checksLoading: false
    }
    const asyncResultKeyRef = {
      current: checksPanelAsyncResultKey(key, 'main', 42, pr.prRepo, 'head-a')
    }
    const input = {
      ...baseInput(),
      pr,
      prCacheKey: key,
      asyncResultKeyRef,
      isCurrentAsyncResult: (requestKey: string) => requestKey === asyncResultKeyRef.current,
      fetchPRForBranch: store.fetchPRForBranch,
      fetchPRChecks: store.fetchPRChecks,
      fetchPRComments: store.fetchPRComments,
      setChecks: vi.fn((next: SetStateAction<PRCheckDetail[]>) => {
        shown.checks = typeof next === 'function' ? next(shown.checks) : next
      }),
      setComments: vi.fn((next: SetStateAction<PRComment[]>) => {
        shown.comments = typeof next === 'function' ? next(shown.comments) : next
      }),
      setChecksLoading: vi.fn((next: SetStateAction<boolean>) => {
        shown.checksLoading = typeof next === 'function' ? next(shown.checksLoading) : next
      })
    }
    const panel = {
      ...input,
      activeWorktree: null,
      isPanelVisible: false,
      gitLabProjectRefRef: { current: null },
      fetchPRCheckDetails: vi.fn(),
      setChecksError: vi.fn(),
      setCommentsError: vi.fn()
    }
    const { result } = renderHook(() => ({
      polling: useChecksPanelPolling(panel),
      reviewData: useChecksPanelReviewData(panel),
      refresh: useChecksPanelManualRefresh(input)
    }))
    let entry: Promise<unknown> = Promise.resolve()
    let click: Promise<void> = Promise.resolve()
    act(() => {
      // Tab entry's forced checks read and the panel's comments load, both begun before the click.
      entry = Promise.all([
        result.current.polling.fetchChecks({ force: true, wakeWslDistro: true }),
        result.current.reviewData.fetchComments()
      ])
      click = result.current.refresh.handleRefresh()
    })
    try {
      await vi.waitFor(() => expect(gh.prComments).toHaveBeenCalledTimes(2))
      expect(gh.prChecks).toHaveBeenCalledTimes(2)
      expect(gh.prChecks).toHaveBeenLastCalledWith(
        expect.objectContaining({ noCache: true, userRefresh: true })
      )
      if (oldFirst) {
        oldChecks.resolve(running)
        oldComments.resolve([comment('old')])
        await act(async () => {})
        expect(shown.checksLoading).toBe(true)
      }
      newChecks.resolve(passed)
      newComments.resolve([comment('new')])
      await act(async () => click)
      oldChecks.resolve(running)
      oldComments.resolve([comment('old')])
      await act(async () => void (await entry))
      expect(input.setChecks).not.toHaveBeenCalledWith(running)
      expect(input.setComments).not.toHaveBeenCalledWith([comment('old')])
      expect(shown).toEqual({ checks: passed, comments: [comment('new')], checksLoading: false })
    } finally {
      oldChecks.resolve([])
      newChecks.resolve([])
      oldComments.resolve([])
      newComments.resolve([])
      await act(async () => void (await Promise.all([entry, click])))
    }
  }
)

it("reports a click's own no-PR answer even if another read fails during its card read", async () => {
  vi.stubGlobal('api', {
    gh: { refreshPRNow: vi.fn(async () => ({ kind: 'no-pr', fetchedAt: Date.now() })) }
  })
  const key = getGitHubPRCacheKey(repo.path, repo.id, 'main')
  useAppStore.setState({ prCache: {}, prRefreshStates: {} })
  const input = {
    ...baseInput(),
    prCacheKey: key,
    fetchPRForBranch: useAppStore.getState().fetchPRForBranch,
    fetchHostedReviewForBranch: vi.fn(async () => {
      useAppStore.setState({
        prRefreshStates: {
          [key]: { status: 'error', reason: 'visible', updatedAt: Date.now(), errorType: 'network' }
        }
      })
      return null
    })
  }
  const panel = renderPanel(input)
  await act(async () => panel.result.current.handleRefresh())
  expect(input.setChecks).toHaveBeenCalledWith([])
  expect(input.setComments).toHaveBeenCalledWith([])
})
