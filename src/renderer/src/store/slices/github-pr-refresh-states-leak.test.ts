/**
 * Memory-leak regression: prRefreshStates must stay bounded.
 *
 * `prRefreshStates` is a Record keyed by PR cache key (repo/branch/execution
 * host) — the SAME unbounded, ephemeral key space the sibling `prRefreshSequences`
 * is already capped against. `applyGitHubPRRefreshEvent` writes a status entry on
 * every status-only refresh event (paused/skipped/in-flight) and re-adds an entry
 * for upstream-error outcomes, but no prune path ever removes them, so the map grew
 * monotonically with the number of distinct (host, repo, branch) tuples observed.
 * The fix caps it to MAX_CACHE_ENTRIES by insertion order (the writer moves each
 * touched key to the most-recent position), exactly like prRefreshSequences.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { GitHubPRRefreshEvent, GitHubPRRefreshReason } from '../../../../shared/types'

// MAX_CACHE_ENTRIES is module-private; mirror its value here.
const MAX_CACHE_ENTRIES = 500

// A prRefreshStates entry shape (the module's PRRefreshState type is not exported).
type SeededRefreshState = { status: 'in-flight'; reason: GitHubPRRefreshReason; updatedAt: number }

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

// A status-only refresh event (no outcome) lands in the prRefreshStates writer.
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

  it('caps prRefreshStates when driven past the cap by the real writer', () => {
    const store = createTestStore()

    // Each distinct branch produces a distinct cache key — an unbounded key space.
    const total = MAX_CACHE_ENTRIES + 150
    for (let i = 0; i < total; i++) {
      store.getState().applyGitHubPRRefreshEvent(statusEvent(`branch-${i}`, 1))
    }

    const states = store.getState().prRefreshStates
    // Bounded — not `total`.
    expect(Object.keys(states)).toHaveLength(MAX_CACHE_ENTRIES)
    // The most-recently-written key survives.
    expect(states[`branch-${total - 1}`]).toBeDefined()
    // The oldest key has been evicted.
    expect(states['branch-0']).toBeUndefined()
  })

  it('caps prRefreshStates and keeps the most recently touched key', () => {
    const store = createTestStore()

    // Seed more state entries than the cap allows.
    const seeded: Record<string, SeededRefreshState> = {}
    const seedCount = MAX_CACHE_ENTRIES + 100
    for (let i = 0; i < seedCount; i++) {
      seeded[`seed-${i}`] = { status: 'in-flight', reason: 'visible', updatedAt: 0 }
    }
    store.setState({ prRefreshStates: seeded })

    // One more status event for a brand-new PR cache key pushes over the cap.
    store.getState().applyGitHubPRRefreshEvent(statusEvent('key-new', 1))

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_CACHE_ENTRIES)
    // The just-touched key survives; the oldest seeded key is evicted.
    expect(states['key-new']).toBeDefined()
    expect(states['seed-0']).toBeUndefined()
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent(statusEvent('only-key', 3))
    expect(store.getState().prRefreshStates['only-key']).toBeDefined()
    expect(store.getState().prRefreshStates['only-key']?.status).toBe('in-flight')
  })

  it('keeps a refreshed older key by moving it to most-recent before capping', () => {
    const store = createTestStore()
    const seeded: Record<string, SeededRefreshState> = {}
    const seedCount = MAX_CACHE_ENTRIES + 100
    for (let i = 0; i < seedCount; i++) {
      seeded[`seed-${i}`] = { status: 'in-flight', reason: 'visible', updatedAt: 0 }
    }
    store.setState({ prRefreshStates: seeded })

    // Refresh the OLDEST key. The writer moves it to most-recent (delete+set),
    // so capping must evict the next-oldest keys, not this freshly-touched one.
    store.getState().applyGitHubPRRefreshEvent(statusEvent('seed-0', 9))

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_CACHE_ENTRIES)
    // Survives — without move-to-end it would be evicted.
    expect(states['seed-0']).toBeDefined()
    // The next-oldest key is the one evicted instead.
    expect(states['seed-1']).toBeUndefined()
  })
})
