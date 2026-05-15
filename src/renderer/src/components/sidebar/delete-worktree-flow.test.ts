import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    settings: { skipDeleteWorktreeConfirm: false },
    worktreeMap: new Map<string, { id: string; displayName: string; isMainWorktree: boolean }>(),
    clearWorktreeDeleteState: vi.fn(),
    openModal: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue({ ok: true }),
    deleteStateByWorktreeId: {}
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/store/selectors', () => ({
  getWorktreeMapFromState: () => mocks.state.worktreeMap
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn()
  }
}))

import { toast } from 'sonner'
import { runWorktreeBatchDelete } from './delete-worktree-flow'

function setWorktrees(
  worktrees: { id: string; displayName?: string; isMainWorktree?: boolean }[]
): void {
  mocks.state.worktreeMap = new Map(
    worktrees.map((worktree) => [
      worktree.id,
      {
        id: worktree.id,
        displayName: worktree.displayName ?? worktree.id,
        isMainWorktree: worktree.isMainWorktree ?? false
      }
    ])
  )
}

describe('runWorktreeBatchDelete', () => {
  beforeEach(() => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.state.clearWorktreeDeleteState.mockClear()
    mocks.state.openModal.mockClear()
    mocks.state.removeWorktree.mockClear().mockResolvedValue({ ok: true })
    mocks.state.deleteStateByWorktreeId = {}
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    setWorktrees([])
  })

  it('filters main worktrees and opens a batch confirmation for eligible targets', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }, { id: 'wt-1' }, { id: 'wt-2' }])

    const started = runWorktreeBatchDelete(['main', 'wt-1', 'wt-2'])

    expect(started).toBe(true)
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledWith('wt-2')
    expect(mocks.state.clearWorktreeDeleteState).not.toHaveBeenCalledWith('main')
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeIds: ['wt-1', 'wt-2']
    })
  })

  it('opens the single-delete confirmation when only one target is eligible', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }, { id: 'wt-1' }])

    const started = runWorktreeBatchDelete(['main', 'wt-1'])

    expect(started).toBe(true)
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', { worktreeId: 'wt-1' })
  })

  it('runs every eligible delete immediately when confirmation is skipped', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([
      { id: 'wt-1', displayName: 'one' },
      { id: 'wt-2', displayName: 'two' }
    ])
    const onDeleted = vi.fn()

    const started = runWorktreeBatchDelete(['wt-1', 'wt-2'], { onDeleted })

    expect(started).toBe(true)
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false)
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-2', false)
    await vi.waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(['wt-1', 'wt-2'])
    })
  })

  it('reports when no selected worktrees are eligible', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }])

    const started = runWorktreeBatchDelete(['main', 'missing'])

    expect(started).toBe(false)
    expect(mocks.state.clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('No deletable workspaces selected', {
      description: 'Refresh Space and try again if the workspace list looks stale.'
    })
  })
})
