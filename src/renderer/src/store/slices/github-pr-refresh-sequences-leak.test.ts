/** Bound PR refresh sequences by MAX_CACHE_ENTRIES across ephemeral host/repo/branch keys; move touched keys to tail so cap evicts idle sequences. */
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

    const seeded: Record<string, number> = {}
    const seedCount = MAX_CACHE_ENTRIES + 100
    for (let i = 0; i < seedCount; i++) {
      seeded[`seed-${i}`] = 1
    }
    store.setState({ prRefreshSequences: seeded })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'visible',
      status: 'in-flight',
      aliases: [{ cacheKey: 'key-new', repoPath: '/repo/new', branch: 'branch-new' }]
    })

    const sequences = store.getState().prRefreshSequences
    expect(Object.keys(sequences)).toHaveLength(MAX_CACHE_ENTRIES)
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

    // Retouch oldest before overflow; eviction must spare it and remove the next oldest.
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 9,
      reason: 'visible',
      status: 'in-flight',
      aliases: [{ cacheKey: 'seed-0', repoPath: '/repo/0', branch: 'branch-0' }]
    })

    const sequences = store.getState().prRefreshSequences
    expect(Object.keys(sequences)).toHaveLength(MAX_CACHE_ENTRIES)
    expect(sequences['seed-0']).toBe(9)
    expect(sequences['seed-1']).toBeUndefined()
  })
})
