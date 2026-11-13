import { describe, expect, it, vi } from 'vitest'
import {
  commands,
  fixture,
  found,
  mocks
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
        acceptRevalidationOnly: true
      })
      reasons.push(params.reason!)
      const result = await commands.getRepoPRForBranch(
        params.repo,
        params.branch,
        params.linkedPRNumber,
        params.fallbackPRNumber,
        params.acceptMergedFallbackPR,
        params.currentHeadOid,
        params.reason,
        params.userRefresh,
        undefined,
        undefined,
        params.acceptRevalidationOnly
      )
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
