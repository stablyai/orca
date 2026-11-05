/** Cap PR refresh statuses across ephemeral host/repo/branch keys. Evict settled error/skipped entries first to preserve visible in-flight/queued/paused pills, then enforce hard bound on active entries only as last resort. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type {
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason
} from '../../../../shared/github/pull-request-refresh-types'

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

    const total = MAX_ENTRIES + 150
    for (let i = 0; i < total; i++) {
      store.getState().applyGitHubPRRefreshEvent(statusEvent(`branch-${i}`, 1))
    }

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_ENTRIES)
    expect(states[`branch-${total - 1}`]).toBeDefined()
    expect(states['branch-0']).toBeUndefined()
  })

  it('evicts settled (error/skipped) statuses before active ones', () => {
    const store = createTestStore()

    // Fill cap with active entries except oldest settled error; overflow must evict settled first.
    const seeded: Record<string, SeedState> = { 'stale-error': errorState() }
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      seeded[`active-${i}`] = inFlightState()
    }
    store.setState({ prRefreshStates: seeded })

    store.getState().applyGitHubPRRefreshEvent(statusEvent('fresh', 1))

    const states = store.getState().prRefreshStates
    expect(Object.keys(states)).toHaveLength(MAX_ENTRIES)
    expect(states['stale-error']).toBeUndefined()
    expect(states['fresh']).toBeDefined()
    expect(states['active-0']).toBeDefined()
    expect(states['active-500']).toBeDefined()
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
