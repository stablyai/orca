/**
 * Memory-leak regression: prRefreshSequences must stay bounded.
 *
 * `prRefreshSequences` is a Record keyed by PR cache key (repo/branch/execution
 * host). `applyGitHubPRRefreshEvent` only ever wrote entries and never removed
 * them, so the map grew monotonically with the number of distinct (host, repo,
 * branch) tuples observed — branches are ephemeral and unbounded over a long
 * session. The fix caps it to MAX_CACHE_ENTRIES, evicting the oldest-touched
 * keys (the writer moves each touched key to the most-recent position).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'

// MAX_CACHE_ENTRIES is module-private; mirror its value here.
const MAX_CACHE_ENTRIES = 500

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

describe('prRefreshSequences stays bounded (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caps prRefreshSequences and keeps the most recently touched key', () => {
    const store = createTestStore()

    // Seed more sequence entries than the cap allows.
    const seeded: Record<string, number> = {}
    const seedCount = MAX_CACHE_ENTRIES + 100
    for (let i = 0; i < seedCount; i++) {
      seeded[`seed-${i}`] = 1
    }
    store.setState({ prRefreshSequences: seeded })

    // One more refresh event for a brand-new PR cache key pushes over the cap.
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'visible',
      status: 'in-flight',
      aliases: [{ cacheKey: 'key-new', repoPath: '/repo/new', branch: 'branch-new' }]
    })

    const sequences = store.getState().prRefreshSequences
    // Bounded — not seedCount + 1.
    expect(Object.keys(sequences)).toHaveLength(MAX_CACHE_ENTRIES)
    // The just-touched key survives; the oldest seeded key is evicted.
    expect(sequences['key-new']).toBe(1)
    expect(sequences['seed-0']).toBeUndefined()
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 3,
      reason: 'visible',
      status: 'in-flight',
      aliases: [{ cacheKey: 'only-key', repoPath: '/repo', branch: 'b' }]
    })
    expect(store.getState().prRefreshSequences['only-key']).toBe(3)
  })

  it('keeps a refreshed older key by moving it to most-recent before capping', () => {
    const store = createTestStore()
    const seeded: Record<string, number> = {}
    const seedCount = MAX_CACHE_ENTRIES + 100
    for (let i = 0; i < seedCount; i++) {
      seeded[`seed-${i}`] = 1
    }
    store.setState({ prRefreshSequences: seeded })

    // Refresh the OLDEST key. The writer moves it to most-recent (delete+set),
    // so capping must evict the next-oldest keys, not this freshly-touched one.
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 9,
      reason: 'visible',
      status: 'in-flight',
      aliases: [{ cacheKey: 'seed-0', repoPath: '/repo/0', branch: 'branch-0' }]
    })

    const sequences = store.getState().prRefreshSequences
    expect(Object.keys(sequences)).toHaveLength(MAX_CACHE_ENTRIES)
    // Survives with its updated sequence; without move-to-end it would be evicted.
    expect(sequences['seed-0']).toBe(9)
    // The next-oldest key is the one evicted instead.
    expect(sequences['seed-1']).toBeUndefined()
  })
})
