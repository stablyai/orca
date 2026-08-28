/**
 * Memory-leak regression: hostedReviewCache must stay bounded on the GitHub
 * PR-refresh write path.
 *
 * `withHostedReviewCacheEntry` caps the map at HOSTED_REVIEW_CACHE_MAX, but the
 * GitHub refresh path writes through `syncHostedReviewCacheFromGitHubPRResult`,
 * which spreads a new key in without ever applying that cap. The key embeds the
 * branch, so the map grows with every distinct (host, repo, branch) tuple a
 * session ever refreshes.
 */
import { describe, it, expect, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { GitHubPRRefreshEvent } from '../../../../shared/github/pull-request-refresh-types'

const MAX_ENTRIES = 500

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

function foundEvent(branch: string, sequence: number): GitHubPRRefreshEvent {
  return {
    sequence,
    reason: 'visible',
    aliases: [
      {
        cacheKey: `local::/repo::${branch}`,
        repoId: '/repo',
        repoPath: '/repo',
        branch,
        executionHostId: 'local'
      }
    ],
    outcome: {
      kind: 'found',
      fetchedAt: sequence,
      pr: {
        number: 1,
        title: 'pr',
        state: 'open',
        url: 'https://example.test/pr/1',
        checksStatus: 'success',
        updatedAt: new Date().toISOString(),
        mergeable: 'MERGEABLE'
      }
    }
  }
}

describe('hostedReviewCache stays bounded on the PR-refresh write path', () => {
  it('caps hostedReviewCache when driven past the cap by the real writer', () => {
    const store = createTestStore()
    const total = MAX_ENTRIES + 150
    for (let i = 0; i < total; i++) {
      store.getState().applyGitHubPRRefreshEvent(foundEvent(`branch-${i}`, i + 1))
    }
    const cache = store.getState().hostedReviewCache
    expect(Object.keys(cache).length).toBeLessThanOrEqual(MAX_ENTRIES)
    // Newest survives, oldest is evicted.
    expect(cache[`local::/repo::branch-${total - 1}`]).toBeDefined()
    expect(cache['local::/repo::branch-0']).toBeUndefined()
  })

  it('keeps every entry while under the cap', () => {
    const store = createTestStore()
    for (let i = 0; i < 10; i++) {
      store.getState().applyGitHubPRRefreshEvent(foundEvent(`kept-${i}`, i + 1))
    }
    const cache = store.getState().hostedReviewCache
    expect(Object.keys(cache)).toHaveLength(10)
    expect(cache['local::/repo::kept-0']).toBeDefined()
  })
})
