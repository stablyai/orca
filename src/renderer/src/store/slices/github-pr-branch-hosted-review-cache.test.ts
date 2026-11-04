// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReviewChecksIndicator } from '@/components/sidebar/WorktreeCardMetadataStatusBadges'
import { summarizeProviderChecks } from '../../../../shared/source-control/checks/provider-check-summary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prChecksCacheSuffix } from '../github/cache-identity'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../github/request-coordination'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { HostedReviewInfo } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.refreshPRNow.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    cleanup()
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it('uses event request start time to reject older PR refreshes that finish later', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/start-race'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const newerReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Newer hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    const stalePR = makePR({ number: 12, title: 'Stale PR status' })

    store.setState({
      prCache: {
        [cacheKey]: {
          data: stalePR,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: newerReview,
          fetchedAt: 3,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      requestStartedAt: 2,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Older request finished late' }),
        fetchedAt: 4
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: newerReview,
      fetchedAt: 3,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('ignores a queued exact linked PR refresh after the worktree was unlinked', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unlinked-event-pr'
    const cacheKey = `${repoId}::${branch}`
    const worktreeId = 'wt-unlinked-event-pr'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-event-pr',
            branch,
            displayName: 'unlinked-event-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      hostedReviewCache: {},
      prCache: {}
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch, worktreeId, linkedPRNumber: 12 }],
      reason: 'visible',
      requestStartedAt: Date.now() - 1_000,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Stale queued linked PR' }),
        fetchedAt: Date.now()
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toBeUndefined()
  })

  it('uses the in-flight event entry to allow same-millisecond coordinator refreshes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-same-ms'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const existingReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Existing same-ms hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'pending',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'UNKNOWN'
    }

    try {
      store.setState({
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: existingReview,
            fetchedAt: 100,
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)

      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        requestStartedAt: 100,
        status: 'in-flight'
      })
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        requestStartedAt: 100,
        outcome: {
          kind: 'found',
          pr: makePR({ number: 12, title: 'Fresh same-ms event PR status' }),
          fetchedAt: 100
        }
      })

      expect(store.getState().prCache[cacheKey]?.data).toMatchObject({
        title: 'Fresh same-ms event PR status'
      })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
        data: expect.objectContaining({ title: 'Fresh same-ms event PR status' }),
        fetchedAt: 100
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies local GitHub PR refresh events without touching runtime-scoped cache', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/runtime'
    const cacheKey = `${repoId}::${branch}`
    const settings = { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    const runtimeHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, settings, repoId)
    const localHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const localChecksCacheKey = `${repoId}::${prChecksCacheSuffix(12, null, 'head-oid')}`
    const runtimeChecksCacheKey = `runtime:env-1::${repoId}::${prChecksCacheSuffix(
      12,
      null,
      'head-oid'
    )}`

    store.setState({
      settings,
      checksCache: {
        [localChecksCacheKey]: {
          data: [{ name: 'test', status: 'completed', conclusion: 'failure', url: null }],
          fetchedAt: 1,
          headSha: 'head-oid'
        },
        [runtimeChecksCacheKey]: {
          data: [{ name: 'test', status: 'completed', conclusion: 'success', url: null }],
          fetchedAt: 1,
          headSha: 'head-oid'
        }
      }
    } as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Local PR status', checksStatus: 'pending' }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]?.data).toMatchObject({
      number: 12,
      title: 'Local PR status',
      checksStatus: 'failure'
    })
    expect(store.getState().prRefreshSequences[cacheKey]).toBe(1)
    expect(store.getState().hostedReviewCache[localHostedReviewCacheKey]?.data).toMatchObject({
      provider: 'github',
      number: 12
    })
    expect(store.getState().hostedReviewCache[runtimeHostedReviewCacheKey]).toBeUndefined()
  })

  it('does not reuse a GitHub-scoped null hosted review cache for neutral discovery', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/github-null-then-gitlab'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 5,
      title: 'GitLab MR',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: null,
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(gitlabReview)

    await expect(
      store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId })
    ).resolves.toEqual(gitlabReview)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith({
      branch,
      currentHeadOid: null,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedGiteaPR: null,
      repoId,
      repoPath,
      reportReadOutcome: true
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: expect.any(Number),
      linkedReviewHintKey: ''
    })
  })

  it('does not clear non-GitHub hosted review cache on a GitHub no-PR refresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/gitlab'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview = {
      provider: 'gitlab' as const,
      number: 5,
      title: 'GitLab MR',
      state: 'open' as const,
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'success' as const,
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE' as const
    }

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: gitlabReview,
          fetchedAt: 1,
          linkedReviewHintKey: 'gitlab:5'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: 1,
      linkedReviewHintKey: 'gitlab:5'
    })
  })
})

it('updates the mounted indicator on complete same-head failure → cancellation → failure and clears absent metadata', async () => {
  const store = createTestStore()
  const branch = 'feature/cancellation'
  const cacheKey = `repo-1::${branch}`
  const hostedKey = getHostedReviewCacheKey('/repo', branch, null, 'repo-1')
  const headSha = 'same-head'
  const checks = Array.from({ length: 100 }, () => ({
    name: 'old run',
    status: 'completed' as const,
    conclusion: 'cancelled' as const,
    url: null
  }))
  const complete = [
    ...checks,
    {
      name: 'real failure',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null
    }
  ]
  let sequence = 0
  function refresh(checksSummary = summarizeProviderChecks(complete)) {
    sequence += 1
    store.getState().applyGitHubPRRefreshEvent({
      sequence,
      reason: 'visible',
      aliases: [{ cacheKey, repoId: 'repo-1', repoPath: '/repo', branch }],
      requestStartedAt: sequence * 100,
      outcome: {
        kind: 'found',
        fetchedAt: sequence * 100 + 1,
        pr: makePR({ checksStatus: 'failure', headSha, checksSummary })
      }
    })
  }
  function Indicator() {
    const review = store((state) => state.hostedReviewCache[hostedKey]?.data)
    return createElement(ReviewChecksIndicator, {
      status: review?.status,
      checksSummary: review?.checksSummary
    })
  }
  const view = render(createElement(TooltipProvider, null, createElement(Indicator)))
  act(() => refresh())
  expect(view.getByLabelText('Checks: Failing').className).toContain('rose')
  // Opening details returns only page one; its cancellation-only rows cannot erase entry 101.
  mockApi.gh.prChecks.mockResolvedValue(checks)
  await act(async () => {
    await store
      .getState()
      .fetchPRChecks('/repo', 12, branch, headSha, undefined, { repoId: 'repo-1' })
  })
  expect(store.getState().prCache[cacheKey]?.data?.checksSummary?.total).toBe(101)
  expect(view.getByLabelText('Checks: Failing').className).toContain('rose')
  act(() => refresh(summarizeProviderChecks([...checks, checks[0]])))
  expect(view.getByLabelText('Checks: Cancelled').className).toContain('muted')
  act(() => refresh())
  expect(view.getByLabelText('Checks: Failing').className).toContain('rose')
  act(() => {
    sequence += 1
    store.getState().applyGitHubPRRefreshEvent({
      sequence,
      reason: 'visible',
      aliases: [{ cacheKey, repoId: 'repo-1', repoPath: '/repo', branch }],
      requestStartedAt: sequence * 100,
      outcome: {
        kind: 'found',
        fetchedAt: sequence * 100 + 1,
        pr: makePR({ checksStatus: 'failure', headSha })
      }
    })
  })
  expect(store.getState().prCache[cacheKey]?.data?.checksSummary).toBeUndefined()
  expect(store.getState().hostedReviewCache[hostedKey]?.data?.checksSummary).toBeUndefined()
  expect(view.getByLabelText('Checks: Failing').className).toContain('rose')

  act(() => refresh(summarizeProviderChecks(checks)))
  expect(view.getByLabelText('Checks: Cancelled').className).toContain('muted')
  mockApi.gh.prChecks.mockResolvedValue([
    { name: 'new run', status: 'queued', conclusion: null, url: null }
  ])
  await act(async () => {
    await store.getState().fetchPRChecks('/repo', 12, branch, headSha, undefined, {
      repoId: 'repo-1',
      force: true
    })
  })
  expect(store.getState().prCache[cacheKey]?.data).toMatchObject({ checksStatus: 'pending' })
  expect(store.getState().prCache[cacheKey]?.data?.checksSummary).toBeUndefined()
  expect(store.getState().hostedReviewCache[hostedKey]?.data).toMatchObject({ status: 'pending' })
  expect(store.getState().hostedReviewCache[hostedKey]?.data?.checksSummary).toBeUndefined()
  expect(view.getByLabelText('Checks: Pending')).toBeDefined()
})
