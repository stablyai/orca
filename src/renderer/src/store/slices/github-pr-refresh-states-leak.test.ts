/**
 * Memory-leak regression: prRefreshStates must stay bounded.
 *
 * `prRefreshStates` is a Record keyed by PR cache key (repo/branch/execution host)
 * — the SAME unbounded, ephemeral key space the sibling `prRefreshSequences` is
 * already capped against. `applyGitHubPRRefreshEvent` writes a status entry on every
 * status-only refresh event (paused/skipped/in-flight) and re-adds one for
 * upstream-error outcomes, but no prune path ever removed them, so the map grew
 * monotonically with the number of distinct (host, repo, branch) tuples observed.
 *
 * The fix bounds it to MAX_PR_REFRESH_STATE_ENTRIES, but because this map backs
 * visible status pills it uses status-aware eviction: settled statuses (error/
 * skipped) are evicted first so an in-progress (in-flight/queued/paused) indicator
 * is never dropped except as a last-resort hard bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { GitHubPRRefreshEvent, GitHubPRRefreshReason } from '../../../../shared/types'

// MAX_PR_REFRESH_STATE_ENTRIES is module-private; mirror its value here.
const MAX_ENTRIES = 2000

// prRefreshStates entry shapes (the module's PRRefreshState type is not exported).
type SeedState = {
  status: 'queued' | 'in-flight' | 'paused' | 'skipped' | 'error'
  reason: GitHubPRRefreshReason
  updatedAt: number
  pausedUntil?: number
  message?: string
}

function inFlightState(): SeedState {
  return { status: 'in-flight', reason: 'visible', updatedAt: Date.now() }
}

function errorState(): SeedState {
  return { status: 'error', reason: 'visible', updatedAt: 0, message: 'boom' }
}

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
    const total = MAX_ENTRIES + 150
    for (let i = 0; i < total; i++) {
      store.getState().applyGitHubPRRefreshEvent(statusEvent(`branch-${i}`, 1))
    }

    const states = store.getState().prRefreshStates
    // Bounded — not `total`.
    expect(Object.keys(states)).toHaveLength(MAX_ENTRIES)
    // The most-recently-written key survives; the oldest is evicted.
    expect(states[`branch-${total - 1}`]).toBeDefined()
    expect(states['branch-0']).toBeUndefined()
  })

  it('evicts settled (error/skipped) statuses before active ones', () => {
    const store = createTestStore()

    // Oldest entry is a settled error; the rest are active in-flight refreshes,
    // filling the map exactly to the cap.
    const seeded: Record<string, SeedState> = { 'stale-error': errorState() }
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      seeded[`active-${i}`] = inFlightState()
    }
    store.setState({ prRefreshStates: seeded })

    // One more active refresh pushes over the cap by one.
    store.getState().applyGitHubPRRefreshEvent(statusEvent('fresh', 1))

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_ENTRIES)
    // The settled error is evicted first; every active entry survives.
    expect(states['stale-error']).toBeUndefined()
    expect(states['fresh']).toBeDefined()
    expect(states['active-0']).toBeDefined()
    expect(states['active-500']).toBeDefined()
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent(statusEvent('only-key', 3))
    expect(store.getState().prRefreshStates['only-key']).toBeDefined()
    expect(store.getState().prRefreshStates['only-key']?.status).toBe('in-flight')
  })

  it('keeps a refreshed older key by moving it to most-recent before capping', () => {
    const store = createTestStore()
    // Fill exactly to the cap with active entries (no settled ones to evict first).
    const seeded: Record<string, SeedState> = {}
    for (let i = 0; i < MAX_ENTRIES; i++) {
      seeded[`seed-${i}`] = inFlightState()
    }
    store.setState({ prRefreshStates: seeded })

    // Refresh the OLDEST key (move-to-end), then add a brand-new key to force a
    // last-resort eviction: the just-refreshed key must survive, the next-oldest not.
    store.getState().applyGitHubPRRefreshEvent(statusEvent('seed-0', 9))
    store.getState().applyGitHubPRRefreshEvent(statusEvent('newcomer', 1))

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_ENTRIES)
    expect(states['seed-0']).toBeDefined()
    expect(states['seed-1']).toBeUndefined()
    expect(states['newcomer']).toBeDefined()
  })

  it('hides expired active states through the effective reader without mutating during read', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      store.setState({
        prRefreshStates: {
          stale: { status: 'in-flight', reason: 'visible', updatedAt: 1_000_000 - 121_000 },
          fresh: { status: 'in-flight', reason: 'visible', updatedAt: 1_000_000 - 10_000 }
        }
      })

      expect(store.getState().getEffectiveGitHubPRRefreshState('stale', 1_000_000)).toBeUndefined()
      expect(store.getState().getEffectiveGitHubPRRefreshState('fresh', 1_000_000)).toMatchObject({
        status: 'in-flight'
      })
      expect(store.getState().prRefreshStates.stale).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires paused states after pausedUntil grace and rejects missing pause timestamps', () => {
    const store = createTestStore()
    store.setState({
      prRefreshStates: {
        currentPause: {
          status: 'paused',
          reason: 'visible',
          updatedAt: 1_000,
          pausedUntil: 2_000
        },
        missingPause: { status: 'paused', reason: 'visible', updatedAt: 1_000 }
      }
    })

    expect(store.getState().getEffectiveGitHubPRRefreshState('currentPause', 2_004)).toMatchObject({
      status: 'paused'
    })
    expect(store.getState().getEffectiveGitHubPRRefreshState('currentPause', 7_001)).toBeUndefined()
    expect(store.getState().getEffectiveGitHubPRRefreshState('missingPause', 1_500)).toBeUndefined()
  })

  it('prunes expired active states on refreshAll without writing a PR miss', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      store.setState({
        prRefreshStates: {
          stale: { status: 'queued', reason: 'visible', updatedAt: 1_000_000 - 121_000 },
          settled: { status: 'error', reason: 'visible', updatedAt: 1, message: 'boom' }
        },
        prCache: {
          stale: { data: null, fetchedAt: 1 }
        },
        repos: [],
        worktreesByRepo: {}
      } as unknown as Partial<AppState>)

      store.getState().refreshAllGitHub()

      expect(store.getState().prRefreshStates.stale).toBeUndefined()
      expect(store.getState().prRefreshStates.settled).toBeDefined()
      expect(store.getState().prCache.stale).toEqual({ data: null, fetchedAt: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual expiry does not remove a newer active state for the same cache key', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const token = {
        sequence: 1,
        status: 'in-flight' as const,
        updatedAt: 1_000_000 - 121_000
      }
      store.setState({
        prRefreshSequences: { branch: 2 },
        prRefreshStates: {
          branch: { status: 'in-flight', reason: 'manual', updatedAt: 1_000_000 }
        }
      })

      store.getState().expireGitHubPRRefreshState('branch', token, 1_000_000)

      expect(store.getState().prRefreshStates.branch).toMatchObject({
        status: 'in-flight',
        updatedAt: 1_000_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual expiry does not notify subscribers when the token no longer matches', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const subscriber = vi.fn()
      const unsubscribe = store.subscribe(subscriber)
      store.setState({
        prRefreshSequences: { branch: 2 },
        prRefreshStates: {
          branch: { status: 'in-flight', reason: 'manual', updatedAt: 1_000_000 }
        }
      })
      subscriber.mockClear()

      store.getState().expireGitHubPRRefreshState(
        'branch',
        {
          sequence: 1,
          status: 'in-flight',
          updatedAt: 1_000_000 - 121_000
        },
        1_000_000
      )

      expect(subscriber).not.toHaveBeenCalled()
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual expiry does not notify subscribers for an active state that is still fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const subscriber = vi.fn()
      store.setState({
        prRefreshSequences: { branch: 1 },
        prRefreshStates: {
          branch: { status: 'in-flight', reason: 'manual', updatedAt: 1_000_000 }
        }
      })
      const unsubscribe = store.subscribe(subscriber)

      store.getState().expireGitHubPRRefreshState(
        'branch',
        {
          sequence: 1,
          status: 'in-flight',
          updatedAt: 1_000_000
        },
        1_000_000
      )

      expect(subscriber).not.toHaveBeenCalled()
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual expiry notifies subscribers when it removes the captured stale active state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const store = createTestStore()
      const subscriber = vi.fn()
      store.setState({
        prRefreshSequences: { branch: 1 },
        prRefreshStates: {
          branch: { status: 'in-flight', reason: 'manual', updatedAt: 1_000_000 - 121_000 }
        }
      })
      const unsubscribe = store.subscribe(subscriber)

      store.getState().expireGitHubPRRefreshState(
        'branch',
        {
          sequence: 1,
          status: 'in-flight',
          updatedAt: 1_000_000 - 121_000
        },
        1_000_000
      )

      expect(subscriber).toHaveBeenCalledTimes(1)
      expect(store.getState().prRefreshStates.branch).toBeUndefined()
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
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
