import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const mocks = vi.hoisted(() => {
  const state: {
    activeWorktreeId: string | null
    updateWorktreeMeta: ReturnType<typeof vi.fn>
    setActiveWorktree: ReturnType<typeof vi.fn>
  } = {
    activeWorktreeId: null,
    updateWorktreeMeta: vi.fn(),
    setActiveWorktree: vi.fn()
  }
  return {
    state,
    sleepingIds: new Set<string>(),
    runSleepWorktrees: vi.fn(),
    commitFocus: vi.fn(),
    prepareFocus: vi.fn(),
    activateAndRevealWorktree: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  hasWorktreeSleepIntent: (id: string) => mocks.sleepingIds.has(id)
}))
vi.mock('./sleep-worktree-flow', () => ({
  runSleepWorktrees: mocks.runSleepWorktrees
}))
vi.mock('./active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: mocks.prepareFocus
}))

import {
  isArchivableWorktree,
  runArchiveWorktrees,
  runRestoreArchivedWorktree
} from './archive-worktree-flow'

describe('archive-worktree-flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sleepingIds.clear()
    mocks.state.activeWorktreeId = null
    mocks.state.updateWorktreeMeta.mockResolvedValue({ ok: true })
    mocks.runSleepWorktrees.mockImplementation(async (ids: readonly string[]) => {
      ids.forEach((id) => mocks.sleepingIds.add(id))
    })
    mocks.prepareFocus.mockReturnValue(mocks.commitFocus)
  })

  it('archives only workspaces still asleep after the batch and offers undo', async () => {
    // wt-2 failed to sleep; wt-3 was reopened by the user mid-batch.
    mocks.runSleepWorktrees.mockImplementation(async () => {
      mocks.sleepingIds.add('wt-1')
    })

    await runArchiveWorktrees(['wt-1', 'wt-2', 'wt-3'])

    expect(mocks.state.updateWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(mocks.state.updateWorktreeMeta).toHaveBeenCalledWith('wt-1', {
      isArchived: true
    })
    const [, options] = mocks.toastSuccess.mock.calls[0]
    options.action.onClick()
    expect(mocks.state.updateWorktreeMeta).toHaveBeenLastCalledWith('wt-1', {
      isArchived: false
    })
  })

  it('moves focus off the active workspace after archiving it', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runArchiveWorktrees(['wt-1'])

    expect(mocks.prepareFocus).toHaveBeenCalledWith('wt-1')
    expect(mocks.commitFocus).toHaveBeenCalledTimes(1)
  })

  it('reports a failed undo write', async () => {
    await runArchiveWorktrees(['wt-1'])
    mocks.state.updateWorktreeMeta.mockResolvedValue({
      ok: false,
      error: 'nope'
    })

    const [, options] = mocks.toastSuccess.mock.calls[0]
    options.action.onClick()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
  })

  it('reports metadata failures alongside partial success', async () => {
    mocks.state.updateWorktreeMeta.mockImplementation(async (id: string) =>
      id === 'wt-2' ? { ok: false, error: 'nope' } : { ok: true }
    )

    await runArchiveWorktrees(['wt-1', 'wt-2'])

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('keeps the active workspace selected when its archive write fails', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.runSleepWorktrees.mockImplementation(async () => {
      mocks.sleepingIds.add('wt-1')
      mocks.state.activeWorktreeId = null
    })
    mocks.state.updateWorktreeMeta.mockResolvedValue({
      ok: false,
      error: 'nope'
    })

    await runArchiveWorktrees(['wt-1'])

    expect(mocks.commitFocus).not.toHaveBeenCalled()
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith('wt-1')
  })

  it('reports a failed metadata write instead of a success toast', async () => {
    mocks.state.updateWorktreeMeta.mockResolvedValue({
      ok: false,
      error: 'nope'
    })

    await runArchiveWorktrees(['wt-1'])

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('restores and opens an archived workspace', async () => {
    await runRestoreArchivedWorktree('wt-1')

    expect(mocks.state.updateWorktreeMeta).toHaveBeenCalledWith('wt-1', {
      isArchived: false
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      navigationIntent: 'user-open'
    })
  })

  it('does not open a workspace whose restore failed', async () => {
    mocks.state.updateWorktreeMeta.mockResolvedValue({
      ok: false,
      error: 'nope'
    })

    await runRestoreArchivedWorktree('wt-1')

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('excludes primary checkouts, folder workspaces, and already-archived rows', () => {
    expect(isArchivableWorktree(makeWorktree({ id: 'wt-1', repoId: 'r' }))).toBe(true)
    expect(
      isArchivableWorktree(makeWorktree({ id: 'wt-2', repoId: 'r', isMainWorktree: true }))
    ).toBe(false)
    expect(isArchivableWorktree(makeWorktree({ id: folderWorkspaceKey('f-1'), repoId: 'r' }))).toBe(
      false
    )
    expect(isArchivableWorktree(makeWorktree({ id: 'wt-3', repoId: 'r', isArchived: true }))).toBe(
      false
    )
  })
})
