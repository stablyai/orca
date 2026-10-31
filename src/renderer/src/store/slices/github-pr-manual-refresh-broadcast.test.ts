import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../github/request-coordination'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import type { PRInfo, CheckStatus } from '../../../../shared/github/pull-request-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'

function createRefreshContext(pr: PRInfo | null = null) {
  const store = createTestStore()
  const repoPath = '/repo'
  const repoId = 'repo-1'
  const branch = 'feature/agent-made'
  const worktreeId = 'wt-agent-made'
  const cacheKey = `${repoId}::${branch}`
  const alias = { cacheKey, repoId, repoPath, branch, worktreeId }
  store.setState({
    repos: [
      { id: repoId, path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
    ],
    worktreesByRepo: {
      [repoId]: [makePRRefreshWorktree({ id: worktreeId, repoId, branch, head: 'head-oid' })]
    },
    prCache: { [cacheKey]: { data: pr, fetchedAt: 500 } }
  })
  return { store, repoPath, repoId, branch, worktreeId, cacheKey, alias }
}

describe('manual PR refresh whose outcome main also broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.prChecks.mockReset()
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it('keeps a PR opened outside Orca in the PR cache after Refresh finds it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { store, repoPath, repoId, branch, worktreeId, cacheKey, alias } = createRefreshContext()
    const outcome: PRRefreshOutcome = { kind: 'found', pr: makePR({ number: 6 }), fetchedAt: 1_300 }
    // This ordering used to make the reply delete the PR that the broadcast had just found.
    mockApi.gh.refreshPRNow.mockImplementationOnce(async () => {
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: 1_100,
        status: 'in-flight'
      })
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: 1_100,
        outcome
      })
      return outcome
    })

    await store.getState().fetchPRForBranch(repoPath, branch, { force: true, repoId, worktreeId })

    expect(store.getState().prCache[cacheKey]).toMatchObject({
      data: expect.objectContaining({ number: 6 }),
      fetchedAt: 1_300
    })
  })

  it.each([
    ['drops the PR when a newer lookup found no review', null, undefined],
    [
      'keeps the PR when a newer lookup found the same one',
      hostedReviewInfoFromGitHubPRInfo(
        makePR({ number: 6, title: 'Newer review title', checksStatus: 'success' })
      ),
      6
    ],
    [
      'drops the PR when a newer lookup found the same number in a different repository',
      hostedReviewInfoFromGitHubPRInfo(
        makePR({
          number: 6,
          url: 'https://github.com/another-owner/another-repo/pull/6',
          prRepo: { owner: 'another-owner', repo: 'another-repo', host: 'github.com' }
        })
      ),
      undefined
    ]
  ])('%s between the broadcast and the reply', async (_name, newerReview, expectedPR) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { store, repoPath, repoId, branch, worktreeId, cacheKey, alias } = createRefreshContext()
    const outcome: PRRefreshOutcome = { kind: 'found', pr: makePR({ number: 6 }), fetchedAt: 1_300 }
    mockApi.hostedReview.forBranch.mockResolvedValue(newerReview)
    mockApi.gh.refreshPRNow.mockImplementationOnce(async () => {
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [alias],
        reason: 'manual',
        requestStartedAt: 1_100,
        outcome
      })
      vi.setSystemTime(2_000)
      await store.getState().fetchHostedReviewForBranch(repoPath, branch, { force: true, repoId })
      return outcome
    })

    await store.getState().fetchPRForBranch(repoPath, branch, { force: true, repoId, worktreeId })

    const hostedReviews = Object.values(store.getState().hostedReviewCache)
    expect(hostedReviews).toMatchObject([{ data: newerReview, fetchedAt: 2_000 }])
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(expectedPR)
  })

  const checksSnapshots: { raw: CheckStatus; expected: CheckStatus; check: PRCheckDetail }[] = [
    {
      raw: 'pending',
      expected: 'success',
      check: { name: 'build', status: 'completed', conclusion: 'success', url: null }
    },
    {
      raw: 'success',
      expected: 'failure',
      check: { name: 'build', status: 'completed', conclusion: 'failure', url: null }
    },
    {
      raw: 'success',
      expected: 'pending',
      check: { name: 'build', status: 'in_progress', conclusion: null, url: null }
    }
  ]
  const checksDeliveryCases = checksSnapshots.flatMap((snapshot) =>
    ['broadcast-first', 'reply-first'].map((order) => ({ ...snapshot, order }))
  )
  it.each(checksDeliveryCases)(
    'keeps $expected checks from a concurrent details fetch with $order delivery',
    async ({ raw, expected, check, order }) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_100)
      const prRepo = { owner: 'test-owner', repo: 'test-repo', host: 'github.com' }
      const pr = makePR({ number: 6, headSha: 'head-oid', prRepo, checksStatus: raw })
      const { store, repoPath, repoId, branch, worktreeId, cacheKey } = createRefreshContext(pr)
      let deliverOutcome: () => void = () => {
        throw new Error('PR lookup has not started')
      }
      mockApi.gh.prChecks.mockResolvedValue([check])
      mockApi.gh.refreshPRNow.mockImplementationOnce(async ({ candidate }) => {
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 1,
          aliases: [candidate],
          reason: 'manual',
          requestStartedAt: 1_100,
          status: 'in-flight'
        })
        // A detail poll can finish while the earlier PR snapshot is still loading other metadata.
        vi.setSystemTime(1_200)
        await store
          .getState()
          .fetchPRChecks(repoPath, 6, branch, pr.headSha, prRepo, { force: true, repoId })
        expect(store.getState().prCache[cacheKey]?.data?.checksStatus).toBe(expected)
        vi.setSystemTime(1_300)
        const outcome: PRRefreshOutcome = { kind: 'found', pr, fetchedAt: 1_300 }
        deliverOutcome = () =>
          store.getState().applyGitHubPRRefreshEvent({
            sequence: 1,
            aliases: [candidate],
            reason: 'manual',
            requestStartedAt: 1_100,
            outcome
          })
        if (order === 'broadcast-first') {
          deliverOutcome()
        }
        return outcome
      })

      await store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId,
        fallbackPRNumber: 6,
        reason: 'manual'
      })
      if (order === 'reply-first') {
        deliverOutcome()
      }

      expect(store.getState().prCache[cacheKey]).toMatchObject({
        data: { number: 6, checksStatus: expected },
        fetchedAt: 1_300
      })
      expect(Object.values(store.getState().hostedReviewCache)).toMatchObject([
        { data: { provider: 'github', number: 6, status: expected }, fetchedAt: 1_300 }
      ])
    }
  )
})
