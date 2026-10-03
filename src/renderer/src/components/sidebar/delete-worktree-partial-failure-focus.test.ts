import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '@/store/slices/worktrees-slice-test-harness'

const holder = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => holder.store!.getState(),
    setState: (...args: Parameters<NonNullable<typeof holder.store>['setState']>) =>
      holder.store!.setState(...args),
    subscribe: (...args: Parameters<NonNullable<typeof holder.store>['subscribe']>) =>
      holder.store!.subscribe(...args)
  }
}))

// Stands in for the real activation: selecting the row is what the hand-off is responsible for.
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn((worktreeId: string) => {
    holder.store!.setState({ activeWorktreeId: worktreeId })
    return { primaryTabId: null }
  })
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

vi.mock('./delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: vi.fn()
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { runWorktreeDeleteWithToast, runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { runDialogForceDelete } from './delete-worktree-dialog-force-delete'

function row(name: string, overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: `repo1::/path/${name}`,
    repoId: 'repo1',
    path: `/path/${name}`,
    displayName: name,
    ...overrides
  })
}

const main = row('main', { isMainWorktree: true })
const older = row('older')
const recent = row('recent')
const viewed = row('viewed')

// Git dropped the worktree's registration, but its folder could not be removed.
const PARTIAL_FAILURE = new Error('failed to delete folder: Operation not permitted')

function seed(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  holder.store = store
  store.setState({
    worktreesByRepo: { repo1: [main, older, recent, viewed] },
    activeView: 'terminal',
    activePendingCreationId: null,
    activeWorktreeId: viewed.id,
    lastVisitedAtByWorktreeId: { [older.id]: 100, [recent.id]: 200 },
    deleteStateByWorktreeId: {}
  })
  return store
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

describe('deleting the viewed workspace when the delete partly fails', () => {
  it('sidebar delete lands where a successful delete would once the worktree is gone', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockRejectedValueOnce(PARTIAL_FAILURE)
    mockApi.worktrees.list.mockResolvedValue([main, older, recent])

    const deleted = await runWorktreeDeleteWithToast(
      { id: viewed.id, executionHostId: null },
      'viewed'
    )
    await settle()

    expect(deleted).toBe(false)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, { revealInSidebar: false })
    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })

  it('stays on the workspace when the refresh still lists it (an ordinary failure)', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('workspace has uncommitted changes'))
    mockApi.worktrees.list.mockResolvedValue([main, older, recent, viewed])

    await runWorktreeDeleteWithToast({ id: viewed.id, executionHostId: null }, 'viewed')
    await settle()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBe(viewed.id)
  })

  it('does not move the user when the shells were stopped but git kept the worktree', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      // Stopping the workspace's shells closed its last tab before git failed.
      store.setState({ activeWorktreeId: null })
      throw new Error('fatal: cannot remove a locked working tree')
    })
    mockApi.worktrees.list.mockResolvedValue([main, older, recent, viewed])

    await runWorktreeDeleteWithToast({ id: viewed.id, executionHostId: null }, 'viewed')
    await settle()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('a Force Delete retry from the failure toast lands on the sibling once the worktree is gone', async () => {
    const store = seed()
    mockApi.worktrees.remove
      .mockRejectedValueOnce(new Error('workspace has uncommitted changes'))
      .mockImplementationOnce(async () => {
        store.setState({ activeWorktreeId: null })
        throw PARTIAL_FAILURE
      })
    mockApi.worktrees.list
      .mockResolvedValueOnce([main, older, recent, viewed])
      .mockResolvedValue([main, older, recent])

    await runWorktreeDeleteWithToast({ id: viewed.id, executionHostId: null }, 'viewed')
    await settle()
    expect(store.getState().activeWorktreeId).toBe(viewed.id)

    vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0][0].onForceDelete?.()
    await settle()
    await settle()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, { revealInSidebar: false })
    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })

  it('leaves the user in place when the follow-up refresh itself fails', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      // Emptied selection, so only the refresh's answer keeps the committer from acting.
      store.setState({ activeWorktreeId: null })
      throw PARTIAL_FAILURE
    })
    mockApi.worktrees.list.mockRejectedValue(new Error('git unavailable'))

    await runWorktreeDeleteWithToast({ id: viewed.id, executionHostId: null }, 'viewed')
    await settle()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBeNull()
    mockApi.worktrees.list.mockReset()
  })

  it('keeps the workspace the user moved to while the delete was running', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      store.setState({ activeWorktreeId: older.id })
      throw PARTIAL_FAILURE
    })
    mockApi.worktrees.list.mockResolvedValue([main, older, recent])

    await runWorktreeDeleteWithToast({ id: viewed.id, executionHostId: null }, 'viewed')
    await settle()

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(store.getState().activeWorktreeId).toBe(older.id)
  })

  it('batch delete lands on a surviving workspace once the viewed one is gone', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockImplementation(async (args: { worktreeId?: string }) => {
      if (args?.worktreeId === viewed.id) {
        throw PARTIAL_FAILURE
      }
    })
    mockApi.worktrees.list.mockResolvedValue([main, older])

    await runWorktreeDeletesInParallel([viewed, recent])
    await settle()

    expect(store.getState().activeWorktreeId).toBe(older.id)
    mockApi.worktrees.remove.mockReset()
  })

  it('the dialog Force Delete lands where a successful delete would once the worktree is gone', async () => {
    const store = seed()
    mockApi.worktrees.remove.mockRejectedValueOnce(PARTIAL_FAILURE)
    mockApi.worktrees.list.mockResolvedValue([main, older, recent])

    runDialogForceDelete({
      worktreeId: viewed.id,
      currentWorktrees: [viewed],
      removeWorktree: store.getState().removeWorktree,
      closeModal: vi.fn(),
      onDeleted: vi.fn()
    })
    await settle()
    await settle()

    expect(store.getState().activeWorktreeId).toBe(recent.id)
  })
})
