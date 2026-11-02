import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import {
  _clearGitHubPRRefreshStartedEntriesForTest,
  prRefreshStartedHostedReviewEntries,
  prRefreshStartedLinkedReviewScopes
} from '../github/request-coordination'
import {
  buildGitHubPRRefreshStateClearToken,
  getGitHubPRRefreshStateExpiryAt
} from '../github/pr-refresh-state'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import {
  createTestStore,
  installLinkedPRClearStub,
  makePR,
  makePRRefreshWorktree
} from './github-slice-test-harness'

function setup(population: number) {
  const store = createTestStore()
  const repoId = 'repo-1'
  const repoPath = '/repo'
  const first = makePRRefreshWorktree({
    id: 'wt-0',
    repoId,
    branch: 'feature/0',
    head: 'shared-head',
    linkedPR: 12
  })
  const worktrees = [
    first,
    ...Array.from({ length: population - 1 }, (_, index) => ({
      ...first,
      id: `wt-${index + 1}`,
      branch: `feature/${index + 1}`
    }))
  ]
  const update = installLinkedPRClearStub(store, {
    repoId,
    repoPath,
    branch: first.branch,
    worktree: first
  })
  store.setState({
    worktreesByRepo: { [repoId]: worktrees },
    hostedReviewCache: Object.fromEntries(
      worktrees.map((worktree) => [
        getHostedReviewCacheKey(repoPath, worktree.branch, null, repoId),
        { data: null, fetchedAt: Date.now() }
      ])
    )
  })
  const aliases = worktrees.map((worktree) => ({
    repoId,
    repoPath,
    branch: worktree.branch,
    cacheKey: `${repoId}::${worktree.branch}`,
    worktreeId: worktree.id,
    linkedPRNumber: 12,
    currentHeadOid: worktree.head
  }))
  const start = (sequence = 1, requestAliases = aliases) =>
    store.getState().applyGitHubPRRefreshEvent({
      sequence,
      reason: 'manual',
      aliases: requestAliases,
      status: 'in-flight',
      requestStartedAt: Date.now()
    })
  const finish = (
    sequence = 1,
    outcome: PRRefreshOutcome = {
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-head',
        headDivergedFromMergedPRAtOid: 'shared-head'
      }),
      fetchedAt: Date.now()
    }
  ) => store.getState().applyGitHubPRRefreshEvent({ sequence, reason: 'manual', aliases, outcome })
  return { store, update, aliases, repoId, start, finish }
}

describe('linked review scope lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    vi.setSystemTime(Date.UTC(2026, 0, 1))
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it('clears every eligible link in a refresh exceeding the 128-entry cache limit', () => {
    const population = 129
    const { store, update, repoId, start, finish } = setup(population)
    start()
    expect(prRefreshStartedHostedReviewEntries.size).toBe(128)
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(population)
    finish()

    expect(update).toHaveBeenCalledTimes(population)
    expect(store.getState().worktreesByRepo[repoId].every((row) => row.linkedPR === null)).toBe(
      true
    )
    expect(prRefreshStartedHostedReviewEntries.size).toBe(0)
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
    finish()
    expect(update).toHaveBeenCalledTimes(population)
  })

  it.each(['paused', 'skipped'] as const)('retires all scopes when a refresh is %s', (status) => {
    const { store, update, aliases, start, finish } = setup(512)
    start()
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 2,
      reason: 'manual',
      aliases,
      ...(status === 'paused'
        ? { status, pausedUntil: Date.now() + 60_000, skippedReason: 'rate-limit' as const }
        : { status, skippedReason: 'fresh' as const })
    })
    expect(prRefreshStartedHostedReviewEntries.size).toBe(0)
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
    finish()
    expect(update).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'no-pr', fetchedAt: 1 },
    { kind: 'upstream-error', errorType: 'network', message: 'Offline', fetchedAt: 1 }
  ] satisfies PRRefreshOutcome[])('releases scopes after a $kind outcome', (outcome) => {
    const { start, finish, update } = setup(129)
    start()
    finish(1, outcome)
    expect(prRefreshStartedHostedReviewEntries.size).toBe(0)
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps successor scopes when a superseded refresh completes late', () => {
    const { start, finish, update } = setup(512)
    start(1)
    start(2)
    finish(1)
    expect(update).not.toHaveBeenCalled()
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(512)
    finish(2)
    expect(update).toHaveBeenCalledTimes(512)
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
  })

  it('preserves expiry order when a scope is superseded', () => {
    const { store, aliases, start } = setup(2)
    start(1, [aliases[0]])
    vi.advanceTimersByTime(60_000)
    start(2, [aliases[1]])
    vi.advanceTimersByTime(30_000)
    start(3, [aliases[0]])
    vi.advanceTimersByTime(90_001)
    store.getState().refreshAllGitHub()
    expect([...prRefreshStartedLinkedReviewScopes.keys()]).toEqual([aliases[0].cacheKey])
    vi.advanceTimersByTime(30_000)
    store.getState().refreshAllGitHub()
    expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
  })

  it.each(['sweep', 'event', 'token'] as const)(
    'retires abandoned scopes through %s cleanup',
    (cleanup) => {
      const { store, aliases, start, finish, update } = setup(1)
      start()
      const key = aliases[0].cacheKey
      const state = store.getState()
      const refresh = state.prRefreshStates[key]
      const expiry = getGitHubPRRefreshStateExpiryAt(refresh)
      const token = buildGitHubPRRefreshStateClearToken(refresh, state.prRefreshSequences, key)
      if (expiry === null || token === null) {
        throw new Error('Expected an active refresh')
      }
      vi.advanceTimersByTime(expiry - Date.now() + 1)
      if (cleanup === 'sweep') {
        store.getState().refreshAllGitHub()
      } else if (cleanup === 'token') {
        store.getState().expireGitHubPRRefreshState(key, token)
      } else {
        store.getState().applyGitHubPRRefreshEvent({
          sequence: 2,
          reason: 'visible',
          aliases: [{ cacheKey: 'unrelated', repoPath: '/other', branch: 'other' }],
          status: 'queued'
        })
      }
      expect(prRefreshStartedHostedReviewEntries.size).toBe(0)
      expect(prRefreshStartedLinkedReviewScopes.size).toBe(0)
      finish()
      expect(update).not.toHaveBeenCalled()
    }
  )
})
