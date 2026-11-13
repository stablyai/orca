import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '../../src/renderer/src/store/types'
import type {
  GitHubPRRefreshEvent,
  PRRefreshOutcome,
  PRSnapshotReply
} from '../../src/shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  makeCandidate,
  makePR
} from '../../src/main/github/pull-requests/refresh/pr-refresh-coordinator-test-harness'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn(), gate: vi.fn() }))
vi.mock('../../src/main/github/client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../../src/main/github/accounts/github-project-account', () => ({
  githubPRPolicyProjects: () => ({ source: null, selection: 0 }),
  resolveGitHubProjectAccount: () => null
}))
vi.mock('../../src/main/github/execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../src/main/github/pull-requests/refresh/pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: mocks.gate
}))
vi.mock('../../src/main/github/pull-requests/refresh/pr-refresh-renderer-port', () => ({
  prRefreshRenderers: () => ({ isRendererOpen: () => true, sendToTrustedUI: mocks.send })
}))

let context: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  mocks.resolve.mockReset()
  mocks.send.mockReset()
  mocks.gate.mockReset().mockResolvedValue(null)
  context = await fixture()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function fixture() {
  const { createGitHubSlice } = await import('../../src/renderer/src/store/github/github')
  const coordinator =
    await import('../../src/main/github/pull-requests/refresh/pr-refresh-coordinator')
  const { RuntimeHostedReviewCommands } =
    await import('../../src/main/runtime/integrations/reviews/runtime-hosted-review-commands')
  const candidate = makeCandidate({
    cacheKey: 'repo::feature/test',
    repoId: 'repo',
    currentHeadOid: 'head-sha'
  })
  const repo = {
    id: 'repo',
    path: '/repo',
    kind: 'git' as const,
    displayName: 'repo',
    badgeColor: '',
    addedAt: 0
  }
  const commands = new RuntimeHostedReviewCommands({
    resolveRepo: async () => repo,
    resolveTarget: async () => ({ repo, repoPath: repo.path }),
    getExecutionOptions: () => undefined,
    recordCreated: () => {}
  })
  const store = createStore<AppState>()((set, get, api) => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- This fixture supplies only the state read by real PR event application.
    ...({
      settings: {},
      repos: [repo],
      worktreesByRepo: {
        repo: [{ id: 'wt-1', repoId: 'repo', branch: candidate.branch, head: 'head-sha' }]
      },
      prCache: {},
      hostedReviewCache: {},
      prRefreshStates: {},
      prRefreshSequences: {}
    } as unknown as AppState),
    ...createGitHubSlice(set, get, api)
  }))
  mocks.send.mockImplementation((_channel, event: GitHubPRRefreshEvent) => {
    store.getState().applyGitHubPRRefreshEvent(event)
  })
  vi.stubGlobal('window', {
    api: {
      gh: {
        refreshPRNow: (args: Parameters<typeof window.api.gh.refreshPRNow>[0]) =>
          coordinator.refreshPRNow(args.candidate, args.reason, { userRefresh: args.userRefresh })
      }
    }
  })
  const foreground = (forced = false) =>
    commands.getRepoPRForBranch(
      'repo',
      candidate.branch,
      null,
      null,
      false,
      'head-sha',
      'active',
      forced
    )
  const found = (title: string): PRRefreshOutcome => ({
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({ title })
  })
  return { coordinator, candidate, store, foreground, found }
}

it.each(['queued', 'immediate'] as const)(
  'delivers the accepted external result after a rejected late %s completion',
  async (origin) => {
    const { coordinator, candidate, store, foreground, found } = context
    const old = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(old.promise).mockImplementation(async () => found('current'))
    coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
    let immediate: Promise<PRSnapshotReply> | undefined
    if (origin === 'immediate') {
      immediate = coordinator.refreshPRNow(candidate, 'active')
    }
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    await expect(foreground(origin === 'immediate')).resolves.toMatchObject({
      fetchedAt: 5_000,
      pr: { title: 'current' }
    })
    vi.setSystemTime(6_000)
    old.resolve({ kind: 'no-pr', fetchedAt: 6_000 })
    await immediate
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
      fetchedAt: 5_000,
      data: { title: 'current' }
    })
    expect(store.getState().prRefreshStates[candidate.cacheKey]?.status).not.toBe('in-flight')
    const { preparePRBranchRead } =
      await import('../../src/main/github/client/lookup/pr-for-branch-outcome')
    const prepared = await preparePRBranchRead('/repo', candidate.branch, null, null, null, {
      currentHeadOid: 'head-sha'
    })
    expect(prepared.cached()?.outcome).toMatchObject({ fetchedAt: 5_000, pr: { title: 'current' } })
    mocks.resolve.mockImplementation(async () => found('next ordinary read'))
    await vi.advanceTimersByTimeAsync(118_999)
    expect(store.getState().prCache[candidate.cacheKey]?.data?.title).toBe('current')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
      fetchedAt: 125_000,
      data: { title: 'next ordinary read' }
    })
  }
)

it('keeps the accepted external failure and gate when the old local success completes', async () => {
  const { coordinator, candidate, store, foreground, found } = context
  const old = Promise.withResolvers<PRRefreshOutcome>()
  mocks.resolve.mockReturnValueOnce(old.promise).mockImplementation(async () => ({
    kind: 'upstream-error',
    fetchedAt: Date.now(),
    errorType: 'rate_limited',
    message: 'wait',
    retryDisabledUntil: 305_000
  }))
  coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  vi.setSystemTime(5_000)
  await expect(foreground()).resolves.toMatchObject({ errorType: 'rate_limited' })
  vi.setSystemTime(6_000)
  old.resolve(found('obsolete'))
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getState().prCache[candidate.cacheKey]?.data).toBeUndefined()
  expect(store.getState().prRefreshStates[candidate.cacheKey]).toMatchObject({
    status: 'error',
    retryDisabledUntil: 305_000,
    nextAutoRetryAt: 305_000
  })
  await expect(coordinator.refreshPRNow(candidate)).resolves.toMatchObject({
    errorType: 'rate_limited'
  })
  mocks.resolve.mockImplementation(async () => found('after gate'))
  await vi.advanceTimersByTimeAsync(298_999)
  expect(store.getState().prCache[candidate.cacheKey]?.data).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
    fetchedAt: 305_000,
    data: { title: 'after gate' }
  })
})

it.each(['queued', 'immediate'] as const)(
  'finishes rejected %s loading and later delivers the pending actual result',
  async (origin) => {
    const { coordinator, candidate, store, foreground, found } = context
    const old = Promise.withResolvers<PRRefreshOutcome>()
    const fresh = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
    const immediate = origin === 'immediate' ? coordinator.refreshPRNow(candidate, 'active') : null
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(5_000)
    const external = foreground(origin === 'immediate')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(6_000)
    old.resolve({ kind: 'no-pr', fetchedAt: 6_000 })
    if (immediate) {
      await expect(immediate).resolves.toEqual({
        revalidation: { invalidated: true, retryAfterMs: 10_000 }
      })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().prCache[candidate.cacheKey]).toBeUndefined()
    expect(store.getState().prRefreshStates[candidate.cacheKey]?.status).toBe('skipped')
    await vi.advanceTimersByTimeAsync(1_000)
    fresh.resolve(found('current'))
    await external
    await vi.advanceTimersByTimeAsync(4_000)
    expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
      fetchedAt: 7_000,
      data: { title: 'current' }
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  }
)

it('keeps rejected raw data out of the actual local action reply writer', async () => {
  const { coordinator, candidate, store, foreground, found } = context
  const old = Promise.withResolvers<PRRefreshOutcome>()
  const fresh = Promise.withResolvers<PRRefreshOutcome>()
  store.setState({
    prCache: { [candidate.cacheKey]: { fetchedAt: 500, data: makePR({ title: 'displayed' }) } }
  })
  mocks.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
  const action = store.getState().fetchPRForBranch('/repo', candidate.branch, {
    repoId: 'repo',
    worktreeId: 'wt-1',
    reason: 'active',
    force: true
  })
  await vi.advanceTimersByTimeAsync(0)
  vi.setSystemTime(5_000)
  const external = foreground(true)
  await vi.advanceTimersByTimeAsync(0)
  vi.setSystemTime(6_000)
  old.resolve({ kind: 'no-pr', fetchedAt: 6_000 })
  await expect(action).resolves.toMatchObject({ title: 'displayed' })
  expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
    fetchedAt: 500,
    data: { title: 'displayed' }
  })
  expect(store.getState().prRefreshStates[candidate.cacheKey]?.status).not.toBe('in-flight')
  await vi.advanceTimersByTimeAsync(1_000)
  fresh.resolve(found('current'))
  await external
  await vi.advanceTimersByTimeAsync(4_000)
  expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
    fetchedAt: 500,
    data: { title: 'displayed' }
  })
  await vi.advanceTimersByTimeAsync(109_499)
  expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
    fetchedAt: 500,
    data: { title: 'displayed' }
  })
  await vi.advanceTimersByTimeAsync(1)
  expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
    fetchedAt: 7_000,
    data: { title: 'current' }
  })
})

it.each([
  { duringQuota: false, retryAt: 307_000, failureAt: 7_000, remaining: 295_999 },
  { duringQuota: true, retryAt: 312_000, failureAt: 12_000, remaining: 299_999 }
])(
  'honors a later actual Retry-After error (during quota: $duringQuota)',
  async ({ duringQuota, retryAt, failureAt, remaining }) => {
    const { coordinator, candidate, store, foreground, found } = context
    const old = Promise.withResolvers<PRRefreshOutcome>()
    const fresh = Promise.withResolvers<PRRefreshOutcome>()
    const observe = vi.fn()
    const remove = coordinator.addPRRefreshOutcomeObserver(observe)
    mocks.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    try {
      coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
      await vi.advanceTimersByTimeAsync(0)
      vi.setSystemTime(5_000)
      const external = foreground()
      await vi.advanceTimersByTimeAsync(0)
      vi.setSystemTime(6_000)
      old.resolve({ kind: 'no-pr', fetchedAt: 6_000 })
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().prRefreshStates[candidate.cacheKey]?.status).toBe('skipped')
      const quota = Promise.withResolvers<null>()
      if (duringQuota) {
        mocks.gate.mockReturnValueOnce(quota.promise)
        await vi.advanceTimersByTimeAsync(6_000)
        expect(mocks.gate).toHaveBeenCalledTimes(2)
      } else {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      fresh.reject(new Error('HTTP 429: secondary rate limit\nRetry-After: 300'))
      await expect(external).resolves.toMatchObject({
        errorType: 'rate_limited',
        fetchedAt: failureAt,
        retryDisabledUntil: retryAt
      })
      mocks.resolve.mockImplementation(async () => found('after actual gate'))
      if (duringQuota) {
        quota.resolve(null)
        await vi.advanceTimersByTimeAsync(0)
      } else {
        await vi.advanceTimersByTimeAsync(4_000)
      }
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
      expect(observe).toHaveBeenCalledTimes(1)
      expect(store.getState().prRefreshStates[candidate.cacheKey]).toMatchObject({
        status: 'error',
        nextAutoRetryAt: retryAt,
        retryDisabledUntil: retryAt
      })
      await vi.advanceTimersByTimeAsync(remaining)
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getState().prCache[candidate.cacheKey]).toMatchObject({
        fetchedAt: retryAt,
        data: { title: 'after actual gate' }
      })
      expect(mocks.resolve).toHaveBeenCalledTimes(3)
      expect(observe).toHaveBeenCalledTimes(2)
    } finally {
      remove()
    }
  }
)

it('restores an overdue watch turn after one ordinary actual read', async () => {
  const { coordinator, found } = context
  vi.setSystemTime(241_000)
  const starts: string[] = []
  mocks.resolve.mockImplementation(async ({ branchName }) => {
    starts.push(branchName)
    return found('current')
  })
  const candidate = (branch: string) =>
    makeCandidate({
      branch,
      cacheKey: `/repo::${branch}`,
      currentHeadOid: 'head-sha'
    })
  coordinator.schedulePRWatchRead({ prKey: 'github.com/acme/repo#1' }, candidate('watch-a'), 1_000)
  coordinator.schedulePRWatchRead({ prKey: 'github.com/acme/repo#2' }, candidate('watch-b'), 2_000)
  coordinator.reportVisiblePRRefreshCandidates(
    [candidate('ordinary-a'), candidate('ordinary-b')],
    1,
    1
  )
  await vi.advanceTimersByTimeAsync(20_000)
  expect(starts).toEqual(['watch-a', 'ordinary-a', 'watch-b'])
})

it('admits only the still-owned equal-sequence terminal event', () => {
  const { store, candidate } = context
  const aliases = [candidate]
  const apply = store.getState().applyGitHubPRRefreshEvent
  apply({ aliases, reason: 'active', sequence: 1, status: 'in-flight', requestStartedAt: 1_000 })
  apply({ aliases, reason: 'active', sequence: 2, status: 'in-flight', requestStartedAt: 2_000 })
  apply({ aliases, reason: 'active', sequence: 1, status: 'skipped', skippedReason: 'fresh' })
  expect(store.getState().prRefreshStates[candidate.cacheKey]?.status).toBe('in-flight')
  apply({
    aliases,
    reason: 'active',
    sequence: 2,
    outcome: { kind: 'upstream-error', errorType: 'network', fetchedAt: 3_000, message: 'offline' }
  })
  apply({ aliases, reason: 'active', sequence: 2, status: 'skipped', skippedReason: 'fresh' })
  expect(store.getState().prRefreshStates[candidate.cacheKey]).toMatchObject({
    status: 'error',
    message: 'offline'
  })
})
