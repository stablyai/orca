import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../requests/request-coordination'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from '../github-slice-test-harness'
import type { AppState } from '../../types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getHostedReviewCacheKey } from '../../slices/hosted-review/hosted-review-cache-identity'

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
  _clearGitHubPRRefreshStartedEntriesForTest()
  vi.useRealTimers()
})

describe('createGitHubSlice.fetchPRForBranch', () => {
  it('does not let a same-millisecond direct PR refresh overwrite an external hosted-review write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/same-ms-hosted-review'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const externalReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Same-ms external hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    try {
      store.setState({
        repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
      } as unknown as Partial<AppState>)

      const request = store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId
      })
      store.setState({
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: externalReview,
            fetchedAt: Date.now(),
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)
      resolveRefresh({
        kind: 'found',
        pr: makePR({ number: 12, title: 'Same-ms direct PR refresh' }),
        fetchedAt: Date.now()
      })

      await expect(request).resolves.toBeNull()
      expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: externalReview,
        fetchedAt: 100,
        linkedReviewHintKey: 'github:12'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

// Explicit actions have a newer boundary than cache-strength upgrades.
it.each([true, false])(
  'a click supersedes an already forced poll (old first: %s)',
  async (oldFirst) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = createTestStore()
    const old = Promise.withResolvers<{
      kind: 'found'
      pr: ReturnType<typeof makePR>
      fetchedAt: number
    }>()
    const fresh = Promise.withResolvers<typeof old.promise extends Promise<infer T> ? T : never>()
    const open = makePR({ headSha: 'head-a' })
    const merged = makePR({ state: 'merged', headSha: 'head-b' })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const before = store
      .getState()
      .fetchPRForBranch('/repo', 'topic', { force: true, reason: 'visible' })
    const intent = { force: true, reason: 'manual' as const, userRefresh: true }
    const click = store.getState().fetchPRForBranch('/repo', 'topic', intent)
    try {
      const ordinary = store.getState().fetchPRForBranch('/repo', 'topic', { force: true })
      if (oldFirst) {
        old.resolve({ kind: 'found', pr: open, fetchedAt: 1 })
        await before
      }
      fresh.resolve({ kind: 'found', pr: merged, fetchedAt: 2 })
      expect(await click).toEqual(merged)
      expect(await ordinary).toEqual(merged)
      old.resolve({ kind: 'found', pr: open, fetchedAt: 1 })
      await before
      expect(store.getState().prCache['/repo::topic']?.data?.state).toBe('merged')
    } finally {
      old.resolve({ kind: 'found', pr: open, fetchedAt: 1 })
      fresh.resolve({ kind: 'found', pr: merged, fetchedAt: 2 })
      await Promise.all([before, click])
      vi.useRealTimers()
    }
  }
)
