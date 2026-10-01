import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { _resetHostWorktreeRemovalsForTests } from './worktrees/teardown/host-worktree-removal-state'
import {
  _resetBackgroundWorktreeRemovalBridgeForTests,
  reconcileHostWorktreeRemovals
} from '../../hooks/ipc-events/background-worktree-removal-bridge'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

const mockApi = createStoreCascadesMockApi()
const worktreeId = 'repo1::/path/wt1'
const hostKey = getWorktreeHostIdentity({ id: worktreeId, hostId: 'local' })

function seedRow(
  store: ReturnType<typeof createTestStore>,
  overrides: { removing?: true } = {}
): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: worktreeId,
          repoId: 'repo1',
          path: '/path/wt1',
          hostId: 'local',
          ...overrides
        })
      ]
    }
  })
}

function deleteState(store: ReturnType<typeof createTestStore>) {
  const states = store.getState().deleteStateByWorktreeId
  return states[hostKey] ?? states[worktreeId]
}

describe('removing a worktree the host deletes in the background', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    store = createTestStore()
  })

  afterEach(() => {
    _resetHostWorktreeRemovalsForTests()
    _resetBackgroundWorktreeRemovalBridgeForTests()
  })

  function deferredRemoval(): {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  } {
    const handle = { resolve: (_value: unknown) => {}, reject: (_error: Error) => {} }
    mockApi.worktrees.remove.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          handle.resolve = resolve
          handle.reject = reject
        })
    )
    return handle
  }

  /** Stands in for the listing refresh; `rows` is what the host lists once it lands. */
  function hostListsOnRefresh(rows: 'removed' | 'removing' | 'unmarked' | Error) {
    const refresh = vi.fn()
    refresh.mockImplementation(async () => {
      if (rows instanceof Error) {
        throw rows
      }
      if (rows === 'removed') {
        seedStore(store, { worktreesByRepo: { repo1: [] } })
      } else {
        seedRow(store, rows === 'removing' ? { removing: true } : {})
      }
      return true
    })
    store.setState({ fetchWorktrees: refresh })
    return refresh
  }

  it('keeps the card Deleting until the host replies that the delete finished', async () => {
    seedRow(store)
    const host = deferredRemoval()
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    await vi.waitFor(() => expect(mockApi.worktrees.remove).toHaveBeenCalled())

    expect(deleteState(store)?.isDeleting).toBe(true)
    expect(store.getState().worktreesByRepo.repo1?.map((row) => row.id)).toEqual([worktreeId])

    host.resolve({ preservedBranch: { branchName: 'feature', head: 'abc123' } })
    await expect(removal).resolves.toMatchObject({
      ok: true,
      preservedBranch: { branchName: 'feature', head: 'abc123' }
    })
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    // The preserved-branch notice reaches the user through the same path an inline delete used.
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('shows the host error from the reply on the card', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRow(store)
    const refresh = hostListsOnRefresh('unmarked')
    mockApi.worktrees.remove.mockRejectedValue(
      new Error('Failed to delete worktree at /path/wt1. Permission denied')
    )

    await expect(
      store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    ).resolves.toEqual({
      ok: false,
      error: 'Failed to delete worktree at /path/wt1. Permission denied'
    })
    expect(deleteState(store)).toMatchObject({
      isDeleting: false,
      error: 'Failed to delete worktree at /path/wt1. Permission denied'
    })
    // A host refusal is an answer, not a lost reply.
    expect(refresh).not.toHaveBeenCalled()
  })

  it('finishes a delete whose reply timed out once the host listing drops the row', async () => {
    seedRow(store)
    const refresh = hostListsOnRefresh('removing')
    mockApi.worktrees.remove.mockRejectedValue(new Error('Request timed out: worktree.rm'))
    const removal = store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(deleteState(store)).toMatchObject({ isDeleting: true, error: null })

    seedStore(store, { worktreesByRepo: { repo1: [] } })
    reconcileHostWorktreeRemovals(store)
    await expect(removal).resolves.toEqual({ ok: true })
  })

  it('reports a delete whose reply was lost and that the host lists without the marker', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRow(store, { removing: true })
    hostListsOnRefresh('unmarked')
    mockApi.worktrees.remove.mockRejectedValue(new Error('Remote Orca runtime connection closed.'))

    await expect(
      store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    ).resolves.toEqual({ ok: false, error: 'The delete did not finish. Try again.' })
  })

  it('treats a row the refreshed listing no longer has as deleted', async () => {
    seedRow(store)
    hostListsOnRefresh('removed')
    mockApi.worktrees.remove.mockRejectedValue(new Error('Request timed out: worktree.rm'))

    await expect(
      store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    ).resolves.toEqual({ ok: true })
  })

  it('reports the lost reply when the host listing cannot be read either', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedRow(store)
    hostListsOnRefresh(new Error('Remote Orca runtime is not connected.'))
    mockApi.worktrees.remove.mockRejectedValue(new Error('Request timed out: worktree.rm'))

    await expect(
      store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    ).resolves.toEqual({ ok: false, error: 'Request timed out: worktree.rm' })
  })

  it('shows Deleting on a client that did not start the delete, from the host marker alone', () => {
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)).toMatchObject({ isDeleting: true, phase: 'deleting' })

    // Git finished: the row leaves the listing.
    seedStore(store, { worktreesByRepo: { repo1: [] } })
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)).toBeUndefined()
  })

  it('shows the existing card error when a row it marked Deleting comes back unmarked', () => {
    seedRow(store, { removing: true })
    reconcileHostWorktreeRemovals(store)

    seedRow(store)
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)).toMatchObject({
      isDeleting: false,
      error: 'The delete did not finish. Try again.'
    })
  })

  it('leaves a delete this renderer started to that flow', () => {
    seedRow(store, { removing: true })
    store.getState().markWorktreesDeleting([{ id: worktreeId, hostId: 'local' }])
    reconcileHostWorktreeRemovals(store)
    seedRow(store)
    reconcileHostWorktreeRemovals(store)
    expect(deleteState(store)?.isDeleting).toBe(true)
  })
})
