import { describe, expect, it, vi } from 'vitest'
import {
  commands,
  fixture,
  found,
  mocks,
  rpcRead
} from '../../../../../main/runtime/integrations/reviews/runtime-hosted-pr-snapshot-test-harness'
import type { PRRefreshOutcome } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

describe('hosted PR receipt delivery', () => {
  it('carries a real deferred reply through the visible target, store and scheduler to its completion', async () => {
    const {
      createTestStore,
      makePRRefreshWorktree,
      resetRemoteRuntimeMocks,
      runtimeEnvironmentCall
    } = await import('../github-slice-test-harness')
    const { getVisibleHostedReviewRefreshTargets } =
      await import('../../slices/hosted-review/refresh/visible-hosted-review-refresh-targets')
    const { createVisibleHostedReviewRefreshScheduler } =
      await import('../../slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler')
    const { PrForBranch } =
      await import('../../../../../shared/rpc-contract/github-pull-request-params')
    const readReceipt = (reason: 'active' | 'swr') =>
      commands.getRepoPRForBranch(
        'repo',
        'receipt',
        12,
        null,
        false,
        'head-a',
        reason,
        undefined,
        undefined,
        undefined,
        true
      )
    resetRemoteRuntimeMocks()
    const store = createTestStore()
    const seed = await readReceipt('active')
    if (!('kind' in seed) || seed.kind !== 'found') {
      throw new Error('expected the initial PR')
    }
    store.setState({
      repos: [
        {
          id: 'repo',
          path: '/repo',
          kind: 'git',
          executionHostId: 'runtime:env-1',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 0
        }
      ],
      worktreesByRepo: {
        repo: [
          makePRRefreshWorktree({
            id: 'receipt-worktree',
            repoId: 'repo',
            branch: 'receipt',
            head: 'head-a',
            linkedPR: 12,
            hostId: 'runtime:env-1',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      },
      detectedWorktreesByRepo: {},
      activeWorktreeId: 'receipt-worktree',
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      visibleReviewWorktreeIds: ['receipt-worktree'],
      prCache: { 'runtime:env-1::repo::receipt': { data: seed.pr, fetchedAt: 1_000 } }
    })
    const reasons: string[] = []
    const replies: unknown[] = []
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      if (args.method !== 'github.prForBranch') {
        throw new Error('unexpected fixture RPC')
      }
      const params = PrForBranch.parse(args.params)
      expect(params).toMatchObject({
        repo: 'repo',
        branch: 'receipt',
        linkedPRNumber: 12,
        currentHeadOid: 'head-a',
        reason: 'swr',
        acceptRevalidationOnly: true,
        selected: true
      })
      reasons.push(params.reason!)
      const result = await rpcRead(args.params)
      replies.push(result)
      return { id: 'rpc', ok: true, result }
    })
    const timerProvider = Promise.withResolvers<PRRefreshOutcome>()
    const freshProvider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve
      .mockReturnValueOnce(timerProvider.promise)
      .mockReturnValueOnce(freshProvider.promise)
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const update = () =>
      scheduler.update(getVisibleHostedReviewRefreshTargets(store.getState(), store.getState))
    const unsubscribe = store.subscribe(update)
    try {
      expect(getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)).toMatchObject([
        { selected: true, intervalMs: 60_000, fetchedAt: 1_000 }
      ])
      update()
      scheduler.setVisible(true)
      await vi.advanceTimersByTimeAsync(60_000)
      // Fake timers defer the host's nested zero-delay drain to the next clock tick.
      await vi.advanceTimersByTimeAsync(1)
      expect(reasons).toEqual(['swr'])
      expect(replies).toEqual([])
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
      const otherClient = readReceipt('active')
      await vi.advanceTimersByTimeAsync(0)
      fixture.title = 'superseded provider result'
      timerProvider.resolve(found())
      await vi.advanceTimersByTimeAsync(0)
      expect(replies).toMatchObject([{ fetchedAt: 1_000, revalidation: { retryAfterMs: 10_000 } }])
      expect(store.getState().prCache['runtime:env-1::repo::receipt']?.data?.title).toBe('before')
      expect(store.getState().prCache['runtime:env-1::repo::receipt']?.fetchedAt).toBe(1_000)
      fixture.title = 'completed by another client'
      freshProvider.resolve(found())
      await otherClient
      await vi.advanceTimersByTimeAsync(9_999)
      expect(reasons).toEqual(['swr'])
      await vi.advanceTimersByTimeAsync(1)
      expect(reasons).toEqual(['swr', 'swr'])
      expect(store.getState().prCache['runtime:env-1::repo::receipt']?.data?.title).toBe(
        'completed by another client'
      )
      expect(mocks.resolve).toHaveBeenCalledTimes(3)
    } finally {
      unsubscribe()
      scheduler.dispose()
    }
  })
})

it('applies data-bearing retry replies to both clients and sends selection after an unselected wait', async () => {
  const seed = await commands.getRepoPRForBranch(
    'repo',
    'shared',
    12,
    null,
    false,
    'head-a',
    'active'
  )
  if (!('kind' in seed) || seed.kind !== 'found') {
    throw new Error('expected initial PR')
  }
  const clients: {
    select: () => void
    title: () => string | undefined
    fetchedAt: () => number | undefined
    dispose: () => void
  }[] = []
  const selection: boolean[][] = [[], []]
  const receipts: unknown[][] = [[], []]
  const reasons: string[] = []
  for (let client = 0; client < 2; client += 1) {
    // Separate module graphs retain each renderer's own request coalescer.
    vi.resetModules()
    const {
      createTestStore,
      makePRRefreshWorktree,
      resetRemoteRuntimeMocks,
      runtimeEnvironmentCall
    } = await import('../github-slice-test-harness')
    const { getVisibleHostedReviewRefreshTargets } =
      await import('../../slices/hosted-review/refresh/visible-hosted-review-refresh-targets')
    const { createVisibleHostedReviewRefreshScheduler } =
      await import('../../slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler')
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      if (args.method !== 'github.prForBranch') {
        throw new Error('unexpected fixture RPC')
      }
      const { PrForBranch } =
        await import('../../../../../shared/rpc-contract/github-pull-request-params')
      const params = PrForBranch.parse(args.params)
      const requestClient = 'selector' in args && args.selector === 'env-client-0' ? 0 : 1
      reasons.push(params.reason ?? 'missing')
      selection[requestClient].push(params.selected === true)
      const result = await rpcRead(args.params)
      receipts[requestClient].push(result)
      return { id: 'rpc', ok: true, result }
    })
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'repo',
          path: '/repo',
          kind: 'git',
          executionHostId: `runtime:env-client-${client}`,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 0
        }
      ],
      worktreesByRepo: {
        repo: [
          makePRRefreshWorktree({
            id: 'shared-worktree',
            repoId: 'repo',
            branch: 'shared',
            head: 'head-a',
            linkedPR: 12,
            hostId: `runtime:env-client-${client}`,
            runtimeOwnerEnvironmentId: `env-client-${client}`
          })
        ]
      },
      detectedWorktreesByRepo: {},
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: `runtime:env-client-${client}`,
      visibleReviewWorktreeIds: ['shared-worktree'],
      prCache: {
        [`runtime:env-client-${client}::repo::shared`]: { data: seed.pr, fetchedAt: seed.fetchedAt }
      }
    })
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const update = () =>
      scheduler.update(getVisibleHostedReviewRefreshTargets(store.getState(), store.getState))
    const unsubscribe = store.subscribe(update)
    update()
    scheduler.setVisible(true)
    clients.push({
      select: () => store.setState({ activeWorktreeId: 'shared-worktree' }),
      title: () =>
        store.getState().prCache[`runtime:env-client-${client}::repo::shared`]?.data?.title,
      fetchedAt: () =>
        store.getState().prCache[`runtime:env-client-${client}::repo::shared`]?.fetchedAt,
      dispose: () => {
        unsubscribe()
        scheduler.dispose()
      }
    })
  }
  try {
    // A second client's fresh result can settle in the same millisecond as the first.
    fixture.title = 'changed on another client'
    await commands.getRepoPRForBranch('repo', 'shared', 12, null, false, 'head-a', 'active')
    mocks.gate.mockResolvedValue(181_000)
    await vi.advanceTimersByTimeAsync(120_001)
    // The first job learns the quota pause after admission, so its wait ends at the response deadline.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(selection).toEqual([[false], [false]])
    for (let client = 0; client < 2; client += 1) {
      expect(receipts[client]).toMatchObject([
        {
          kind: 'found',
          pr: { title: 'changed on another client' },
          revalidation: { retryAfterMs: expect.any(Number) }
        }
      ])
      expect(clients[client].title()).toBe('changed on another client')
      expect(clients[client].fetchedAt()).toBe(1_000)
      clients[client].select()
    }
    mocks.gate.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(70_000)
    expect(selection).toEqual([
      [false, true],
      [false, true]
    ])
    expect(reasons).toEqual(['swr', 'swr', 'swr', 'swr'])
    for (const client of clients) {
      expect(client.title()).toBe('changed on another client')
      expect(client.fetchedAt()).toBe(181_000)
    }
    expect(mocks.resolve).toHaveBeenCalledTimes(3)
  } finally {
    for (const client of clients) {
      client.dispose()
    }
  }
})
