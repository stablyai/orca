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
    clearWorktreeDeleteState: vi.fn((worktreeId: string) => {
      delete state.deleteStateByWorktreeId[worktreeId]
    }),
    markWorktreesDeleting: vi.fn((worktreeIds: readonly string[]) => {
      for (const worktreeId of new Set(worktreeIds)) {
        state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }),
    openModal: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue({ ok: true }),
    gitStatusByWorktree: {} as Record<string, unknown[]>,
    deleteStateByWorktreeId: {} as Record<
      string,
      {
        isDeleting?: boolean
        error?: string | null
        canForceDelete?: boolean
        forceDeleteReason?: 'dirty' | null
        lockReason?: string | null
      }
    >
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/store/selectors', () => ({
  getAllWorktreesFromState: () => Array.from(mocks.state.worktreeMap.values()),
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

vi.mock('./delete-worktree-failure-toast', () => ({
  showDeleteWorktreeFailureToast: vi.fn()
}))

import { toast } from 'sonner'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import {
  runWorktreeBatchDelete,
  runWorktreeDelete,
  runWorktreeDeletesInParallel
} from './delete-worktree-flow'

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

describe('delete worktree flow', () => {
  beforeEach(() => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.state.clearWorktreeDeleteState.mockClear()
    mocks.state.markWorktreesDeleting.mockClear()
    mocks.state.openModal.mockClear()
    mocks.state.removeWorktree.mockClear().mockResolvedValue({ ok: true })
    mocks.state.deleteStateByWorktreeId = {}
    mocks.state.gitStatusByWorktree = {}
    mocks.state.worktreeLineageById = {}
    mocks.state.repos = []
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(showDeleteWorktreeFailureToast).mockClear()
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
      worktreeDeleteIdentities: [
        { id: 'wt-1', instanceId: 'wt-1-instance' },
        { id: 'wt-2', instanceId: 'wt-2-instance' }
      ],
      allowSkipConfirm: false
    })
  })

  it('opens the single-delete confirmation when only one target is eligible', () => {
    setWorktrees([{ id: 'main', isMainWorktree: true }, { id: 'wt-1' }])

    const started = runWorktreeBatchDelete(['main', 'wt-1'])

    expect(started).toBe(true)
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'wt-1',
      worktreeDeleteIdentities: [{ id: 'wt-1', instanceId: 'wt-1-instance' }]
    })
  })

  it('treats duplicate selected ids as one delete target', () => {
    setWorktrees([{ id: 'wt-1' }])

    const started = runWorktreeBatchDelete(['wt-1', 'wt-1'])

    expect(started).toBe(true)
    expect(mocks.state.clearWorktreeDeleteState).toHaveBeenCalledTimes(1)
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeId: 'wt-1',
      worktreeDeleteIdentities: [{ id: 'wt-1', instanceId: 'wt-1-instance' }]
    })
  })

  it('rejects the whole batch when a selected path belongs to a different instance', () => {
    setWorktrees([
      { id: 'wt-1', instanceId: 'instance-1' },
      { id: 'wt-2', instanceId: 'instance-2' }
    ])

    const started = runWorktreeBatchDelete([
      { id: 'wt-1', instanceId: 'instance-1' },
      { id: 'wt-2', instanceId: 'replaced-instance' }
    ])

    expect(started).toBe(false)
    expect(mocks.state.clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace list changed',
      expect.objectContaining({
        description: 'Refresh Space and try again if the workspace list looks stale.'
      })
    )
  })

  it('opens batch confirmation when every selected instance is still current', () => {
    setWorktrees([
      { id: 'wt-1', instanceId: 'instance-1' },
      { id: 'wt-2', instanceId: 'instance-2' }
    ])

    const started = runWorktreeBatchDelete([
      { id: 'wt-1', instanceId: 'instance-1' },
      { id: 'wt-2', instanceId: 'instance-2' }
    ])

    expect(started).toBe(true)
    expect(toast.info).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith('delete-worktree', {
      worktreeIds: ['wt-1', 'wt-2'],
      worktreeDeleteIdentities: [
        { id: 'wt-1', instanceId: 'instance-1' },
        { id: 'wt-2', instanceId: 'instance-2' }
      ],
      allowSkipConfirm: false
    })
  })

  it('revalidates each queued instance immediately before execution', async () => {
    setWorktrees([
      { id: 'wt-1', instanceId: 'instance-1', path: '/workspaces/first-longer' },
      { id: 'wt-2', instanceId: 'instance-2', path: '/workspaces/second' }
    ])
    const targets = Array.from(mocks.state.worktreeMap.values())
    let finishFirst!: (result: { ok: true }) => void
    mocks.state.removeWorktree.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve))
    )

    const deletion = runWorktreeDeletesInParallel(targets)
    await vi.waitFor(() =>
      expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false, {
        suppressPreservedBranchToast: true
      })
    )
    setWorktrees([
      { id: 'wt-1', instanceId: 'instance-1', path: '/workspaces/first-longer' },
      { id: 'wt-2', instanceId: 'replacement-instance', path: '/workspaces/second' }
    ])
    finishFirst({ ok: true })

    await expect(deletion).resolves.toEqual(['wt-1'])
    expect(mocks.state.removeWorktree).not.toHaveBeenCalledWith('wt-2', false, {
      suppressPreservedBranchToast: true
    })
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace list changed',
      expect.objectContaining({
        description: 'Refresh Space and try again if the workspace list looks stale.'
      })
    )
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
      worktreeDeleteIdentities: [
        { id: 'wt-1', instanceId: 'wt-1-instance' },
        { id: 'wt-2', instanceId: 'wt-2-instance' }
      ],
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
    mocks.state.removeWorktree
      .mockImplementationOnce(async (worktreeId: string) => {
        mocks.state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: false,
          error: 'changed files',
          canForceDelete: true,
          forceDeleteReason: 'dirty'
        }
        return { ok: false, error: 'changed files' }
      })
      .mockResolvedValueOnce({ ok: true })
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])
    const onDeleted = vi.fn()

    expect(runWorktreeBatchDelete(['wt-1'], { onDeleted })).toBe(true)

    await vi.waitFor(() => expect(showDeleteWorktreeFailureToast).toHaveBeenCalled())
    const toastOptions = vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0]?.[0]
    toastOptions?.onForceDelete()

    await vi.waitFor(() => {
      // Why (#11960): clicking Force Delete on the failure toast is an explicit
      // force, so it also waives the PTY-stop proof the first attempt failed.
      expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(2, 'wt-1', true, {
        allowUnverifiedPtyStop: true
      })
      expect(onDeleted).toHaveBeenCalledWith(['wt-1'])
    })
  })

  it('does not offer force delete for a locked worktree', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    mocks.state.removeWorktree
      .mockImplementationOnce(async (worktreeId: string) => {
        mocks.state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: false,
          error: 'Worktree is locked by Git.',
          canForceDelete: false,
          forceDeleteReason: null,
          lockReason: 'active agent session'
        }
        return { ok: false, error: 'Worktree is locked by Git.' }
      })
      .mockResolvedValueOnce({ ok: true })
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])

    expect(runWorktreeBatchDelete(['wt-1'])).toBe(true)

    await vi.waitFor(() => expect(showDeleteWorktreeFailureToast).toHaveBeenCalled())
    const toastOptions = vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0]?.[0]
    expect(toastOptions).toMatchObject({
      canForceDelete: false,
      forceDeleteReason: null,
      lockReason: 'active agent session'
    })
    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('keeps parent worktree deletes behind confirmation even when confirmation is skipped', () => {
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
      worktreeDeleteIdentities: [{ id: 'parent', instanceId: 'parent-instance' }],
      lineageDeleteIdentities: [
        { id: 'child', instanceId: 'child-instance' },
        { id: 'parent', instanceId: 'parent-instance' }
      ],
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
      worktreeDeleteIdentities: [{ id: 'parent', instanceId: 'parent-instance' }],
      lineageDeleteIdentities: [
        { id: 'child', instanceId: 'child-instance' },
        { id: 'parent', instanceId: 'parent-instance' }
      ],
      allowSkipConfirm: false
    })
  })

  it('reports a stale list instead of silently dropping a delete whose row vanished', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([])

    runWorktreeDelete('wt-1')

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.state.clearWorktreeDeleteState).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace list changed',
      expect.objectContaining({
        description: 'Refresh Space and try again if the workspace list looks stale.'
      })
    )
  })

  it('rejects a delayed delete when the path now belongs to a different instance', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', instanceId: 'instance-2' }])

    runWorktreeDelete('wt-1', { expectedInstanceId: 'instance-1' })

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace list changed',
      expect.objectContaining({
        description: 'Refresh Space and try again if the workspace list looks stale.'
      })
    )
  })

  it('runs a delayed delete when the captured instance is still current', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', instanceId: 'instance-1', displayName: 'one' }])

    runWorktreeDelete('wt-1', { expectedInstanceId: 'instance-1' })

    expect(toast.info).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false)
  })

  // Why: the delete-current-workspace shortcut (useIpcEvents) forwards whatever workspace is
  // active, and a folder workspace is never in the worktree map — claiming it vanished would lie.
  it('stays silent for a folder workspace, which this funnel does not route', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([])

    runWorktreeDelete('folder:11111111-2222-3333-4444-555555555555')

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('does not report a stale list when the workspace is still present', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])

    runWorktreeDelete('wt-1')

    expect(toast.info).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktree).toHaveBeenCalledWith('wt-1', false)
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
      worktreeDeleteIdentities: [{ id: 'wt-1', instanceId: 'wt-1-instance' }],
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
