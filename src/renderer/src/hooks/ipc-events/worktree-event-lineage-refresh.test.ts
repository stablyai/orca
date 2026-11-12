import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../../store/slices/worktrees/worktrees-slice-test-harness'
import { makeDetectedResult } from '../../store/slices/worktrees/listing/worktrees-detected-listing-fixtures'
import { makeLineage } from '../../store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../store/repos/repo.test-fixture'

import { advanceRuntimeEnvironmentConnectionGeneration } from '../../store/slices/runtime-status/runtime-status-connection-generation'
import { WORKTREE_SORT_ORDER_BATCH_WINDOW_MS } from './worktree-sort-order-publication-batch'
import { createWorktreeEventRuntime } from './worktree-event-runtime'

import {
  beginWorktreeLineageRefresh,
  invalidateRemoteWorktreeLineage,
  isRemoteWorktreeLineageFresh
} from '../../store/slices/worktrees/metadata/worktree-lineage-readiness'

let store: ReturnType<typeof createTestStore>
let unsubs: (() => void)[]

vi.mock('../../store', () => ({
  useAppStore: {
    get getState() {
      return store.getState
    },
    get setState() {
      return store.setState
    }
  }
}))
const sshStateGeneration = vi.hoisted(() => ({ value: 0 }))
vi.mock('@/store/slices/ssh/runtime-environment-ssh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironmentSshStateGeneration: () => sshStateGeneration.value
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

async function flushPromises() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  store = createTestStore()
  unsubs = []
  store.setState({
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    purgeWorktreeTerminalState: vi.fn(),
    removeWorkspaceSpaceWorktrees: vi.fn(),
    migrateWorktreeIdentity: vi.fn(),
    setActiveWorktree: vi.fn()
  })
  beginWorktreeLineageRefresh(store.getState, { kind: 'environment', environmentId: 'env-1' })(true)
})

afterEach(() => {
  for (const unsubscribe of unsubs) {
    unsubscribe()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('remote worktree event lineage refresh', () => {
  it('leaves a workspace the user picked during the rename refresh selected', async () => {
    store.setState({
      activeWorktreeId: 'repo-rename::/old',
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      fetchWorktrees: vi.fn().mockImplementation(async () => {
        store.setState({ activeWorktreeId: 'repo-other::/picked' })
        return true
      })
    })
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({
      repoId: 'repo-rename',
      executionHostId: 'runtime:env-1',
      renamed: { oldWorktreeId: 'repo-rename::/old', newWorktreeId: 'repo-rename::/new' }
    })
    await flushPromises()

    expect(store.getState().setActiveWorktree).not.toHaveBeenCalled()
  })

  it('leaves the other twin copy the user picked during the rename refresh selected', async () => {
    store.setState({
      activeWorktreeId: 'repo-rename::/old',
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      migrateWorktreeIdentity: vi.fn(() =>
        store.setState({ activeWorktreeId: 'repo-rename::/new' })
      ),
      fetchWorktrees: vi.fn().mockImplementation(async () => {
        store.setState({ activeWorkspaceExecutionHostId: 'local' })
        return true
      })
    })
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({
      repoId: 'repo-rename',
      executionHostId: 'runtime:env-1',
      renamed: { oldWorktreeId: 'repo-rename::/old', newWorktreeId: 'repo-rename::/new' }
    })
    await flushPromises()

    expect(store.getState().setActiveWorktree).not.toHaveBeenCalled()
  })
})

function createActualActionFixture() {
  store = createTestStore()
  const worktree = makeWorktree({
    id: 'repo::/remote/child',
    repoId: 'repo',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1',
    sortOrder: 10
  })
  const lineage = makeLineage({ worktreeId: worktree.id })
  let sortOrder = 10
  let listingHold: Promise<void> = Promise.resolve()
  let lineageReply: () => Promise<unknown> = async () => ({ lineage: { [worktree.id]: lineage } })
  runtimeEnvironmentCall.mockImplementation(async ({ method }) => {
    let result: unknown
    if (method === 'worktree.lineageList') {
      result = await lineageReply()
    } else {
      await listingHold
      result = makeDetectedResult('repo', [{ ...worktree, sortOrder }])
    }
    return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
  })
  store.setState({
    settings: null,
    repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'runtime:env-1' }],
    worktreesByRepo: { repo: [worktree] },
    sortEpoch: 7,
    purgeWorktreeTerminalState: vi.fn(),
    removeWorkspaceSpaceWorktrees: vi.fn()
  })
  const runtime = createWorktreeEventRuntime(unsubs, () => false)
  return {
    lineage,
    worktree,
    queue: runtime.worktreeChangeRefreshQueue,
    setOrder: (value: number) => {
      sortOrder = value
    },
    holdListing: (promise: Promise<void>) => {
      listingHold = promise
    },
    setLineageReply: (reply: () => Promise<unknown>) => {
      lineageReply = reply
    },
    lineageReadCount: () =>
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'worktree.lineageList'
      ).length,
    warm: () => store.getState().fetchWorktreeLineage({ executionHostId: 'runtime:env-1' })
  }
}

describe('order-only refresh with actual store actions', () => {
  it('hydrates a cold client, then takes an older host order save without a lineage download or re-sort', async () => {
    const h = createActualActionFixture()
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
    await vi.waitFor(() => expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(true))
    expect(h.lineageReadCount()).toBe(1)
    expect(store.getState().worktreeLineageById[h.worktree.id]).toEqual(h.lineage)
    const beforeEpoch = store.getState().sortEpoch
    h.setOrder(20)
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
    await vi.waitFor(() => expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(20))
    await flushPromises()
    // A sortOrder-only refetch must not schedule the next Smart re-sort and save (#27268).
    expect(store.getState().sortEpoch).toBe(beforeEpoch)
    expect(h.lineageReadCount()).toBe(1)
  })

  it.each([true, false])(
    'fences only the submitted repository listing (same repository: %s)',
    async (sameRepo) => {
      vi.useFakeTimers()
      const h = createActualActionFixture()
      await h.warm()
      const fetch = vi.spyOn(store.getState(), 'fetchWorktrees')
      const publishedOrders: number[] = []
      const unsubscribe = store.subscribe((state) => {
        publishedOrders.push(state.worktreesByRepo.repo[0].sortOrder)
      })
      unsubs.push(unsubscribe)
      h.queue.enqueue({
        repoId: 'repo',
        executionHostId: 'runtime:env-1',
        sortOrderOnly: true,
        sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
      })
      h.setOrder(42)
      if (sameRepo) {
        await store.getState().fetchWorktrees('repo', { executionHostId: 'runtime:env-1' })
        expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(42)
      } else {
        store.setState((state) => ({
          worktreesByRepo: { ...state.worktreesByRepo, unrelated: [] }
        }))
      }
      fetch.mockClear()
      await vi.advanceTimersByTimeAsync(WORKTREE_SORT_ORDER_BATCH_WINDOW_MS)
      expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(sameRepo ? 42 : 99)
      expect(fetch).toHaveBeenCalledTimes(sameRepo ? 1 : 0)
      if (sameRepo) {
        expect(publishedOrders).not.toContain(99)
      }
    }
  )

  it('runs a structural refresh queued behind a pending order patch after the patch', async () => {
    const h = createActualActionFixture()
    await h.warm()
    h.queue.enqueue({
      repoId: 'repo',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
    })
    h.setOrder(7)
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    await flushPromises()
    expect(store.getState().worktreesByRepo.repo[0].sortOrder).not.toBe(7)
    // The newer listing lands last, so the older published value cannot overwrite it.
    await vi.waitFor(() => expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(7))
  })

  it.each(['reconnect', 'event-stream gap'] as const)(
    'refetches instead of applying values published before a %s',
    async (gap) => {
      const h = createActualActionFixture()
      await h.warm()
      const listing = Promise.withResolvers<void>()
      h.holdListing(listing.promise)
      h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
      h.queue.enqueue({
        repoId: 'repo',
        executionHostId: 'runtime:env-1',
        sortOrderOnly: true,
        sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
      })
      if (gap === 'reconnect') {
        advanceRuntimeEnvironmentConnectionGeneration('env-1')
      } else {
        sshStateGeneration.value += 1
      }
      h.setOrder(200)
      listing.resolve()
      await vi.waitFor(() => expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(200))
      await flushPromises()
      expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(200)
    }
  )

  it('leaves a same-id row owned by another host untouched', async () => {
    const h = createActualActionFixture()
    const local = makeWorktree({ id: h.worktree.id, repoId: 'repo', hostId: 'local', sortOrder: 5 })
    store.setState({ worktreesByRepo: { repo: [h.worktree, local] } })
    h.queue.enqueue({
      repoId: 'repo',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
    })
    await vi.waitFor(() =>
      expect(store.getState().worktreesByRepo.repo.map((row) => row.sortOrder)).toEqual([99, 5])
    )
  })

  it('retries failed ordinary and best-effort reads on the next order-only event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = createActualActionFixture()
    await h.warm()
    h.setLineageReply(async () => {
      throw new Error('lineage timeout')
    })
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(2))
    await flushPromises()
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(false)
    const updated = { ...h.lineage, parentWorktreeId: 'repo::/remote/new-parent' }
    h.setLineageReply(async () => ({ lineage: { [h.worktree.id]: updated } }))
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
    await vi.waitFor(() =>
      expect(store.getState().worktreeLineageById[h.worktree.id]).toEqual(updated)
    )
    expect(h.lineageReadCount()).toBe(3)

    h.setLineageReply(async () => {
      throw new Error('manual refresh timeout')
    })
    await store.getState().fetchWorktrees('repo', { executionHostId: 'runtime:env-1' })
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(false)
    h.setLineageReply(async () => ({ lineage: { [h.worktree.id]: updated } }))
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(5))
  })

  it('does not let an earlier successful read clear a queued structural event', async () => {
    const h = createActualActionFixture()
    await h.warm()
    const read = Promise.withResolvers<unknown>()
    h.setLineageReply(() => read.promise)
    const manualRead = h.warm()
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(2))
    const listing = Promise.withResolvers<void>()
    h.holdListing(listing.promise)
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    read.resolve({ lineage: {} })
    await manualRead
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(false)
    h.setLineageReply(async () => ({ lineage: {} }))
    listing.resolve()
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(4))
    await flushPromises()
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(true)
  })

  it('does not invalidate a healthy host from an event received after disposal', async () => {
    const h = createActualActionFixture()
    await h.warm()
    h.queue.dispose()
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(true)
    invalidateRemoteWorktreeLineage(store.getState, 'env-1')
    expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(false)
  })
})
