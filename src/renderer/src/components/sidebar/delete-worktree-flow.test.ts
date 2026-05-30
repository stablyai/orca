import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    settings: { skipDeleteWorktreeConfirm: false },
    worktreeMap: new Map<
      string,
      {
        id: string
        instanceId: string
        repoId: string
        path: string
        displayName: string
        isMainWorktree: boolean
      }
    >(),
    repos: [] as { id: string; displayName: string }[],
    worktreeLineageById: {},
    allWorktrees: () => Array.from(state.worktreeMap.values()),
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
import {
  runWorktreeBatchDelete,
  runWorktreeDelete,
  runWorktreeDeletesInParallel
} from './delete-worktree-flow'

function deferredDeleteResult(): {
  promise: Promise<{ ok: true }>
  resolve: (value: { ok: true }) => void
} {
  let resolve: (value: { ok: true }) => void = () => {}
  const promise = new Promise<{ ok: true }>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function setWorktrees(
  worktrees: {
    id: string
    instanceId?: string
    repoId?: string
    path?: string
    displayName?: string
    isMainWorktree?: boolean
  }[]
): void {
  mocks.state.worktreeMap = new Map(
    worktrees.map((worktree) => [
      worktree.id,
      {
        id: worktree.id,
        instanceId: worktree.instanceId ?? `${worktree.id}-instance`,
        repoId: worktree.repoId ?? 'repo-1',
        path: worktree.path ?? `/workspaces/${worktree.id}`,
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
    mocks.state.worktreeLineageById = {}
    mocks.state.repos = []
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
      worktreeIds: ['wt-1', 'wt-2'],
      allowSkipConfirm: false
    })
  })

  it('opens the single-delete confirmation when only one target is eligible', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }, { id: 'wt-1' }])

    const started = runWorktreeBatchDelete(['main', 'wt-1'])

    expect(started).toBe(true)
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', { worktreeId: 'wt-1' })
  })

  it('keeps batch deletes behind confirmation when confirmation is skipped', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([
      { id: 'wt-1', displayName: 'one' },
      { id: 'wt-2', displayName: 'two' }
    ])
    const onDeleted = vi.fn()

    const started = runWorktreeBatchDelete(['wt-1', 'wt-2'], { onDeleted })

    expect(started).toBe(true)
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeIds: ['wt-1', 'wt-2'],
      allowSkipConfirm: false,
      onDeleted
    })
  })

  it('runs a single eligible delete immediately when confirmation is skipped', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])
    const onDeleted = vi.fn()

    const started = runWorktreeBatchDelete(['wt-1'], { onDeleted })

    expect(started).toBe(true)
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false)
    await vi.waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(['wt-1'])
    })
  })

  it('notifies onDeleted after a skip-confirm force delete succeeds', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    mocks.state.deleteStateByWorktreeId = { 'wt-1': { canForceDelete: true } }
    mocks.state.removeWorktree
      .mockResolvedValueOnce({ ok: false, error: 'changed files' })
      .mockResolvedValueOnce({ ok: true })
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])
    const onDeleted = vi.fn()

    expect(runWorktreeBatchDelete(['wt-1'], { onDeleted })).toBe(true)

    await vi.waitFor(() => expect(toast.info).toHaveBeenCalled())
    const toastOptions = vi.mocked(toast.info).mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined
    toastOptions?.action?.onClick?.()

    await vi.waitFor(() => {
      expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-1', true)
      expect(onDeleted).toHaveBeenCalledWith(['wt-1'])
    })
  })

  it('keeps parent workspace deletes behind confirmation even when confirmation is skipped', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([
      { id: 'parent', displayName: 'parent' },
      { id: 'child', displayName: 'child' }
    ])
    const parent = mocks.state.worktreeMap.get('parent')!
    const child = mocks.state.worktreeMap.get('child')!
    mocks.state.worktreeLineageById = {
      child: {
        worktreeId: child.id,
        worktreeInstanceId: child.instanceId,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }

    runWorktreeBatchDelete(['parent'])

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'parent',
      allowSkipConfirm: false
    })
  })

  it('keeps context-menu parent deletes behind confirmation even when confirmation is skipped', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'parent' }, { id: 'child' }])
    const parent = mocks.state.worktreeMap.get('parent')!
    const child = mocks.state.worktreeMap.get('child')!
    mocks.state.worktreeLineageById = {
      child: {
        worktreeId: child.id,
        worktreeInstanceId: child.instanceId,
        parentWorktreeId: parent.id,
        parentWorktreeInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }

    runWorktreeDelete('parent')

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'parent',
      allowSkipConfirm: false
    })
  })

  it('opens project removal confirmation for a primary workspace', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([
      {
        id: 'main',
        repoId: 'repo-1',
        displayName: 'main',
        isMainWorktree: true
      }
    ])
    mocks.state.repos = [{ id: 'repo-1', displayName: 'orca' }]

    runWorktreeDelete('main')

    expect(mocks.state.clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-remove-folder', {
      repoId: 'repo-1',
      displayName: 'orca'
    })
  })

  it('can force confirmation for a single eligible delete', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])
    const onDeleted = vi.fn()

    const started = runWorktreeBatchDelete(['wt-1'], { forceConfirm: true, onDeleted })

    expect(started).toBe(true)
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'wt-1',
      allowSkipConfirm: false,
      onDeleted
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

describe('runWorktreeDeletesInParallel', () => {
  beforeEach(() => {
    mocks.state.removeWorktree.mockClear().mockResolvedValue({ ok: true })
    mocks.state.deleteStateByWorktreeId = {}
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
  })

  it('starts every selected delete before waiting for earlier deletes to finish', async () => {
    const first = deferredDeleteResult()
    const second = deferredDeleteResult()
    mocks.state.removeWorktree
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const deleted = runWorktreeDeletesInParallel([
      { id: 'wt-1', displayName: 'one', repoId: 'repo-a', path: '/workspaces/one' },
      { id: 'wt-2', displayName: 'two', repoId: 'repo-b', path: '/workspaces/two' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'wt-1', false)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-2', false)

    second.resolve({ ok: true })
    await Promise.resolve()
    first.resolve({ ok: true })

    await expect(deleted).resolves.toEqual(['wt-1', 'wt-2'])
  })

  it('deletes nested workspaces before their parent within the same repo', async () => {
    await runWorktreeDeletesInParallel([
      { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
      { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
    ])

    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'parent', false)
  })

  it('does not delete an ancestor when a nested descendant delete fails', async () => {
    mocks.state.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'changed files' })

    await expect(
      runWorktreeDeletesInParallel([
        { id: 'parent', displayName: 'parent', repoId: 'repo-a', path: '/workspaces/parent' },
        { id: 'child', displayName: 'child', repoId: 'repo-a', path: '/workspaces/parent/child' }
      ])
    ).resolves.toEqual([])

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(1, 'child', false)
  })
})
