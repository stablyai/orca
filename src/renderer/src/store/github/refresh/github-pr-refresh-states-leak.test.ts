/** Cap PR refresh statuses across ephemeral host/repo/branch keys. Evict settled error/skipped entries first to preserve visible in-flight/queued/paused pills, then enforce hard bound on active entries only as last resort. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from '../github'
import { createHostedReviewSlice } from '../../slices/hosted-review/hosted-review'
import type { AppState } from '../../types'
import type { GitHubPRRefreshEvent } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    refreshPRNow: vi.fn(),
    enqueuePRRefresh: vi.fn().mockResolvedValue(undefined),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([])
  },
  hostedReview: { forBranch: vi.fn().mockResolvedValue(null) },
  runtimeEnvironments: { call: vi.fn() },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error -- minimal window.api stub for the slice under test
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as AppState
  )
}

function statusEvent(cacheKey: string, sequence: number): GitHubPRRefreshEvent {
  return {
    sequence,
    reason: 'visible',
    status: 'in-flight',
    aliases: [{ cacheKey, repoPath: `/repo/${cacheKey}`, branch: cacheKey }]
  }
}

describe('prRefreshStates stays bounded (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('expires the stale active state captured by a rejected forced PR refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const repoPath = '/repo'
      const branch = 'feature/rejected-refresh'
      const cacheKey = `${repoPath}::${branch}`
      mockApi.gh.refreshPRNow.mockRejectedValueOnce(new Error('stale repo path'))
      store.setState({
        prRefreshSequences: { [cacheKey]: 1 },
        prRefreshStates: {
          [cacheKey]: { status: 'in-flight', reason: 'manual', updatedAt: 1_000_000 - 121_000 }
        }
      })

      await expect(
        store.getState().fetchPRForBranch(repoPath, branch, { force: true })
      ).resolves.toBeNull()

      expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
      expect(store.getState().prCache[cacheKey]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a late terminal outcome after the active status timed out', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const repoPath = '/repo'
      const branch = 'feature/late-outcome'
      const cacheKey = `${repoPath}::${branch}`

      store.getState().applyGitHubPRRefreshEvent(statusEvent(cacheKey, 1))
      vi.setSystemTime(1_000_000 + 121_000)
      expect(store.getState().getEffectiveGitHubPRRefreshState(cacheKey)).toBeUndefined()

      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        reason: 'visible',
        aliases: [{ cacheKey, repoPath, branch }],
        outcome: {
          kind: 'found',
          pr: {
            number: 12,
            title: 'Late PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            checksStatus: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1_000_000 + 121_000
        }
      })

      expect(store.getState().prCache[cacheKey]?.data).toMatchObject({ title: 'Late PR' })
      expect(store.getState().prRefreshStates[cacheKey]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
