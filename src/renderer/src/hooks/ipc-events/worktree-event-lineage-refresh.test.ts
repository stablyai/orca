import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../../store/slices/worktrees-slice-test-harness'
import { makeDetectedResult } from '../../store/slices/worktrees-detected-listing-fixtures'
import {
  makeLineage,
  makeWorktree,
  TEST_REPO
} from '../../store/slices/worktrees-slice-test-fixtures'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/runtime-environment-revision'
import { advanceRuntimeEnvironmentConnectionGeneration } from '../../store/slices/runtime-status-connection-generation'
import { createWorktreeEventRuntime } from './worktree-event-runtime'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
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
vi.mock('@/store/slices/runtime-environment-ssh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironmentSshStateGeneration: () => sshStateGeneration.value
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
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
})

describe('remote worktree event lineage refresh', () => {
  it('downloads zero lineage copies for a 25-repository order save, then refreshes structural changes', async () => {
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    for (let index = 0; index < 25; index += 1) {
      queue.enqueue({
        repoId: `repo-${index}`,
        executionHostId: 'runtime:env-1',
        sortOrderOnly: true
      })
    }
    await flushPromises()
    expect(store.getState().fetchWorktrees).toHaveBeenCalledTimes(25)
    expect(store.getState().fetchWorktreeLineage).not.toHaveBeenCalled()
    expect(store.getState().fetchWorktrees).toHaveBeenCalledWith('repo-0', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })

    queue.enqueue({ repoId: 'repo-0', executionHostId: 'runtime:env-1' })
    await flushPromises()
    expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledWith({
      executionHostId: 'runtime:env-1'
    })

    const lineage = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => {
        const row = makeLineage({
          worktreeId: `repo-${index % 25}::/home/orca/workspaces/project/feature-${index}`,
          parentWorktreeId: `repo-${index % 25}::/home/orca/projects/project`
        })
        return [row.worktreeId, row]
      })
    )
    const responseBytes = Buffer.byteLength(JSON.stringify({ lineage }))
    expect(responseBytes * 25).toBeGreaterThan(900_000)
  })

  it('downloads nothing for a 25-repository save whose host publishes the values', async () => {
    const rows = Array.from({ length: 105 }, (_, index) =>
      makeWorktree({
        id: `repo-${index % 25}::/home/orca/workspaces/project/feature-${index}`,
        repoId: `repo-${index % 25}`,
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1',
        sortOrder: index
      })
    )
    const worktreesByRepo: Record<string, ReturnType<typeof makeWorktree>[]> = {}
    for (const row of rows) {
      ;(worktreesByRepo[row.repoId] ??= []).push(row)
    }
    store.setState({ worktreesByRepo, sortEpoch: 3 })
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    const now = 1_800_000_000_000
    const events = Object.entries(worktreesByRepo).map(([repoId, repoRows]) => ({
      type: 'worktreesChanged' as const,
      repoId,
      sortOrderOnly: true,
      sortOrders: repoRows.map((row, index) => ({
        worktreeId: row.id,
        sortOrder: now - index * 1000
      }))
    }))
    for (const event of events) {
      queue.enqueue({ ...event, executionHostId: 'runtime:env-1' })
    }
    await flushPromises()
    expect(store.getState().fetchWorktrees).not.toHaveBeenCalled()
    expect(store.getState().fetchWorktreeLineage).not.toHaveBeenCalled()
    expect(store.getState().sortEpoch).toBe(3)
    expect(store.getState().worktreesByRepo['repo-0'][0].sortOrder).toBe(now)
    // The save now costs only the pushed events (about 16 KB with real-length ids).
    const eventBytes = events.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0
    )
    expect(eventBytes).toBeLessThan(15_000)
  })

  it.each([undefined, false])(
    'keeps the full refresh for an older or unmarked event (%s)',
    async (sortOrderOnly) => {
      const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
      queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly })
      await flushPromises()
      expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledWith({
        executionHostId: 'runtime:env-1'
      })
    }
  )

  it('leaves concurrent unmarked host reads independent when one read hangs', async () => {
    const slow = Promise.withResolvers<void>()
    const fetchWorktreeLineage = vi
      .fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(undefined)
    store.setState({ fetchWorktreeLineage })
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({ repoId: 'repo-first', executionHostId: 'runtime:env-1' })
    await flushPromises()
    queue.enqueue({ repoId: 'repo-second', executionHostId: 'runtime:env-1' })
    queue.enqueue({ repoId: 'repo-other-host', executionHostId: 'runtime:env-2' })
    await flushPromises()
    expect(fetchWorktreeLineage).toHaveBeenCalledTimes(3)
    expect(fetchWorktreeLineage).toHaveBeenLastCalledWith({ executionHostId: 'runtime:env-2' })
    slow.resolve()
    await flushPromises()
  })

  it('still fetches lineage when an unmarked listing resolves non-authoritatively', async () => {
    store.setState({ fetchWorktrees: vi.fn().mockResolvedValue(false) })
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1' })
    await flushPromises()
    expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledOnce()
  })

  it('preserves rename activation and authoritative deletion cleanup', async () => {
    const deleted = makeWorktree({ id: 'repo-delete::/gone', repoId: 'repo-delete' })
    store.setState({
      activeWorktreeId: 'repo-rename::/old',
      worktreesByRepo: { 'repo-delete': [deleted] },
      fetchWorktrees: vi.fn().mockImplementation(async (repoId: string) => {
        if (repoId === 'repo-delete') {
          store.setState({
            detectedWorktreesByRepo: { 'repo-delete': makeDetectedResult(repoId, []) }
          })
        }
        return true
      })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({
      repoId: 'repo-rename',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      renamed: { oldWorktreeId: 'repo-rename::/old', newWorktreeId: 'repo-rename::/new' }
    })
    queue.enqueue({ repoId: 'repo-delete', executionHostId: 'runtime:env-1' })
    await flushPromises()
    expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledTimes(2)
    expect(store.getState().setActiveWorktree).toHaveBeenCalledWith('repo-rename::/new')
    expect(store.getState().purgeWorktreeTerminalState).toHaveBeenCalledWith([
      hostWorktreeTarget({ id: deleted.id, hostId: 'runtime:env-1' })
    ])
    expect(store.getState().removeWorkspaceSpaceWorktrees).toHaveBeenCalledWith([deleted.id])
  })

  it('keeps forced-local and unowned notifications on their existing refresh paths', async () => {
    const { worktreeChangeRefreshQueue: queue } = createWorktreeEventRuntime(unsubs, () => false)
    queue.enqueue({ repoId: 'local', forceLocalOwner: true, sortOrderOnly: true })
    queue.enqueue({ repoId: 'unowned', sortOrderOnly: true })
    await flushPromises()
    expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledWith({ forceLocalOwner: true })
    expect(store.getState().fetchWorktreeLineage).toHaveBeenCalledWith(undefined)
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

  it('patches a published order save in place without any host read or re-sort', async () => {
    const h = createActualActionFixture()
    await h.warm()
    const readsBefore = runtimeEnvironmentCall.mock.calls.length
    const beforeEpoch = store.getState().sortEpoch
    h.queue.enqueue({
      repoId: 'repo',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
    })
    await flushPromises()
    expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(99)
    expect(store.getState().sortEpoch).toBe(beforeEpoch)
    expect(runtimeEnvironmentCall.mock.calls.length).toBe(readsBefore)
  })

  it('refetches when a published row was never loaded here', async () => {
    const h = createActualActionFixture()
    await h.warm()
    store.setState({ worktreesByRepo: {} })
    h.setOrder(42)
    h.queue.enqueue({
      repoId: 'repo',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
    })
    await vi.waitFor(() => expect(store.getState().worktreesByRepo.repo?.[0]?.sortOrder).toBe(42))
  })

  it('still retries lineage on a published save when the host snapshot is not fresh', async () => {
    const h = createActualActionFixture()
    h.queue.enqueue({
      repoId: 'repo',
      executionHostId: 'runtime:env-1',
      sortOrderOnly: true,
      sortOrders: [{ worktreeId: h.worktree.id, sortOrder: 99 }]
    })
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(1))
    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method !== 'worktree.lineageList'
      )
    ).toEqual([])
    expect(store.getState().worktreesByRepo.repo[0].sortOrder).toBe(99)
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
    await flushPromises()
    expect(store.getState().worktreesByRepo.repo.map((row) => row.sortOrder)).toEqual([99, 5])
  })

  it('still bumps sortEpoch when a refetch changes more than sortOrder', async () => {
    const h = createActualActionFixture()
    const beforeEpoch = store.getState().sortEpoch
    runtimeEnvironmentCall.mockImplementation(async () => ({
      id: 'rpc',
      ok: true,
      result: makeDetectedResult('repo', [{ ...h.worktree, sortOrder: 30, isUnread: true }]),
      _meta: { runtimeId: 'remote-runtime' }
    }))
    await store.getState().fetchWorktrees('repo', { executionHostId: 'runtime:env-1' })
    expect(store.getState().worktreesByRepo.repo[0].isUnread).toBe(true)
    expect(store.getState().sortEpoch).toBe(beforeEpoch + 1)
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

  it.each(['reconnect', 're-pair'] as const)(
    'hydrates again after %s under the same host id',
    async (change) => {
      const h = createActualActionFixture()
      await h.warm()
      if (change === 'reconnect') {
        advanceRuntimeEnvironmentConnectionGeneration('env-1')
      } else {
        replaceRuntimeEnvironmentRevisions([
          { id: 'env-1', createdAt: 1, pairingRevision: Date.now() }
        ])
      }
      h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
      await vi.waitFor(() => expect(h.lineageReadCount()).toBe(2))
      await flushPromises()
      expect(isRemoteWorktreeLineageFresh(store.getState, 'env-1')).toBe(true)
    }
  )

  it('refreshes rather than skips while another repository lineage read is pending', async () => {
    const h = createActualActionFixture()
    await h.warm()
    const pending = Promise.withResolvers<unknown>()
    let next = true
    h.setLineageReply(async () => {
      if (next) {
        next = false
        return pending.promise
      }
      return { lineage: {} }
    })
    const manualRead = h.warm()
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(2))
    h.queue.enqueue({ repoId: 'repo', executionHostId: 'runtime:env-1', sortOrderOnly: true })
    await vi.waitFor(() => expect(h.lineageReadCount()).toBe(3))
    pending.resolve({ lineage: {} })
    await manualRead
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
