import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type MockWorktreeDeleteState = {
  isDeleting?: boolean
  error?: string | null
  canForceDelete?: boolean
  forceDeleteReason?: 'dirty' | null
  lockReason?: string | null
  canWaiveArchiveHook?: boolean
  executionHostId?: ExecutionHostId | null
}

const mocks = vi.hoisted(() => {
  const gitStatusByWorktree: Record<string, unknown[]> = {}
  const deleteStateByWorktreeId: Record<string, MockWorktreeDeleteState> = {}
  const openFiles: {
    id: string
    filePath: string
    worktreeId: string
    isDirty: boolean
    mode: 'edit'
  }[] = []
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
        hostId?: ExecutionHostId
        removalError?: string
      }
    >(),
    repos: [] as { id: string; displayName: string; connectionId?: string }[],
    sshTargetLabels: new Map<string, string>(),
    sshConnectionStates: new Map<string, { status: string }>(),
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
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue({ ok: true }),
    gitStatusByWorktree,
    deleteStateByWorktreeId,
    openFiles,
    editorDrafts: {},
    editorBufferIdOf: {},
    editorBufferViews: {}
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
  getWorktreeMapFromState: () => mocks.state.worktreeMap,
  // Match declared hosts even though this fixture indexes only one worktree per ID.
  getWorktreeOnHostFromState: (_state: unknown, worktreeId: string, hostId?: string) => {
    const row = mocks.state.worktreeMap.get(worktreeId)
    return row && (!hostId || row.hostId === hostId) ? row : undefined
  }
}))

vi.mock('@/components/editor/editor-model-owner', () => ({
  resolveEditorModelOwner: () => ({ environmentId: null, hostId: 'local' }),
  getEditorModelOwnerKey: () => ''
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
  runWorktreeDeleteWithToast,
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
    hostId?: ExecutionHostId
    removalError?: string
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
        isMainWorktree: worktree.isMainWorktree ?? false,
        ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
        ...(worktree.removalError ? { removalError: worktree.removalError } : {})
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
    mocks.state.sshTargetLabels = new Map()
    mocks.state.sshConnectionStates = new Map()
    mocks.state.openFiles = []
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(showDeleteWorktreeFailureToast).mockClear()
    setWorktrees([])
  })

  it('clears stale delete errors for a mixed batch before its dialog opens', () => {
    setWorktrees([{ id: 'wt-failed', removalError: 'Operation not permitted' }, { id: 'wt-dirty' }])
    mocks.state.deleteStateByWorktreeId['wt-failed'] = {
      isDeleting: false,
      error: 'Request timed out',
      canForceDelete: false
    }
    mocks.state.deleteStateByWorktreeId['wt-dirty'] = {
      isDeleting: false,
      error: 'Worktree has uncommitted changes',
      canForceDelete: true
    }

    expect(runWorktreeBatchDelete(['wt-failed', 'wt-dirty'])).toBe(true)

    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'delete-worktree',
      expect.objectContaining({ worktreeIds: ['wt-failed', 'wt-dirty'] })
    )
    expect(mocks.state.deleteStateByWorktreeId).toEqual({})
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

  it('revalidates each queued instance immediately before execution', async () => {
    // Model a host relying on renderer serialization for same-repo branch cleanup.
    setWorktrees([
      {
        id: 'wt-1',
        instanceId: 'instance-1',
        path: '/workspaces/first-longer',
        hostId: 'ssh:builder'
      },
      { id: 'wt-2', instanceId: 'instance-2', path: '/workspaces/second', hostId: 'ssh:builder' }
    ])
    const targets = Array.from(mocks.state.worktreeMap.values())
    let finishFirst!: (result: { ok: true }) => void
    mocks.state.removeWorktree.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve))
    )

    const deletion = runWorktreeDeletesInParallel(targets)
    await vi.waitFor(() =>
      expect(mocks.state.removeWorktree).toHaveBeenCalledWith(
        { id: 'wt-1', executionHostId: 'ssh:builder' },
        false,
        {
          suppressPreservedBranchToast: true
        }
      )
    )
    setWorktrees([
      {
        id: 'wt-1',
        instanceId: 'instance-1',
        path: '/workspaces/first-longer',
        hostId: 'ssh:builder'
      },
      {
        id: 'wt-2',
        instanceId: 'replacement-instance',
        path: '/workspaces/second',
        hostId: 'ssh:builder'
      }
    ])
    finishFirst({ ok: true })

    await expect(deletion).resolves.toEqual([{ id: 'wt-1', executionHostId: 'ssh:builder' }])
    expect(mocks.state.removeWorktree).not.toHaveBeenCalledWith(
      { id: 'wt-2', executionHostId: 'ssh:builder' },
      false,
      {
        suppressPreservedBranchToast: true
      }
    )
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

  it('notifies onDeleted after a skip-confirm force delete succeeds', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    mocks.state.removeWorktree
      .mockImplementationOnce(async ({ id: worktreeId }: { id: string }) => {
        mocks.state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: false,
          executionHostId: null,
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
      // Explicit Force Delete waives the PTY-stop proof that blocked the first attempt.
      expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
        2,
        { id: 'wt-1', executionHostId: null },
        true,
        {
          allowUnverifiedPtyStop: true
        }
      )
      expect(onDeleted).toHaveBeenCalledWith([{ id: 'wt-1', executionHostId: null }])
    })
  })

  it('refuses a Force Delete retry while edits made since the first attempt are unsaved', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    mocks.state.removeWorktree.mockImplementationOnce(
      async ({ id: worktreeId }: { id: string }) => {
        mocks.state.deleteStateByWorktreeId[worktreeId] = {
          isDeleting: false,
          executionHostId: null,
          error: 'changed files',
          canForceDelete: true,
          forceDeleteReason: 'dirty'
        }
        return { ok: false, error: 'changed files' }
      }
    )
    setWorktrees([{ id: 'wt-1', displayName: 'one', path: '/workspaces/wt-1' }])

    expect(runWorktreeBatchDelete(['wt-1'])).toBe(true)
    await vi.waitFor(() => expect(showDeleteWorktreeFailureToast).toHaveBeenCalled())
    mocks.state.openFiles = [
      {
        id: 'f1',
        filePath: '/workspaces/wt-1/a.ts',
        worktreeId: 'wt-1',
        isDirty: true,
        mode: 'edit'
      }
    ]
    vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0]?.[0]?.onForceDelete()

    expect(mocks.state.removeWorktree).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Save or close 1 unsaved file in one first')
  })

  it("does not offer force from another host's racing delete state", async () => {
    mocks.state.removeWorktree.mockReset().mockImplementationOnce(async ({ id: worktreeId }) => {
      mocks.state.deleteStateByWorktreeId[worktreeId] = {
        isDeleting: false,
        executionHostId: 'ssh:builder',
        error: 'changed files',
        canForceDelete: true,
        forceDeleteReason: 'dirty'
      }
      return { ok: false, error: 'Worktree is locked by Git.' }
    })
    await runWorktreeDeleteWithToast({ id: 'wt-1', executionHostId: 'local' }, 'one')

    expect(vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0]?.[0]).toMatchObject({
      canForceDelete: false,
      forceDeleteReason: null,
      lockReason: null
    })
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

  it('keeps the confirm when skip-confirm is on but unsaved editor files would close', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'wt-1', path: '/workspaces/wt-1' }])
    mocks.state.openFiles = [
      {
        id: 'f1',
        filePath: '/workspaces/wt-1/a.ts',
        worktreeId: 'wt-1',
        isDirty: true,
        mode: 'edit'
      }
    ]

    runWorktreeDelete('wt-1')
    expect(runWorktreeBatchDelete(['wt-1'])).toBe(true)

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledTimes(2)
    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'delete-worktree',
      expect.objectContaining({ worktreeId: 'wt-1' })
    )
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

  // Folder shortcuts use another funnel; missing Git worktree records must not imply their disappearance.
  it('stays silent for a folder workspace, which this funnel does not route', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([])

    runWorktreeDelete('folder:11111111-2222-3333-4444-555555555555')

    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('routes primary workspace removal to its exact SSH host', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([
      {
        id: 'main',
        repoId: 'repo-1',
        displayName: 'main',
        isMainWorktree: true,
        hostId: 'ssh:runtime-ssh-one'
      }
    ])
    mocks.state.repos = [
      { id: 'repo-1', displayName: 'local orca' },
      { id: 'repo-1', displayName: 'provisioned orca', connectionId: 'runtime-ssh-one' }
    ]

    runWorktreeDelete('main')

    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-remove-folder', {
      repoId: 'repo-1',
      displayName: 'provisioned orca',
      hostId: 'ssh:runtime-ssh-one'
    })
  })

  // #34677: a connected SSH target does not make this app's main able to delete there.
  it('offers only Remove from Orca for a workspace on a connected SSH target', () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    setWorktrees([{ id: 'repo-1::/srv/wt', displayName: 'wt', hostId: 'ssh:builder' }])
    mocks.state.repos = [{ id: 'repo-1', displayName: 'remote', connectionId: 'builder' }]
    mocks.state.sshTargetLabels = new Map([['builder', 'Builder']])
    mocks.state.sshConnectionStates = new Map([['builder', { status: 'connected' }]])

    runWorktreeDelete('repo-1::/srv/wt')

    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'forget-ssh-workspace',
      expect.objectContaining({ resolution: { kind: 'saved', targetId: 'builder' } })
    )
    expect(mocks.state.removeWorktree).not.toHaveBeenCalled()
  })

  // Waived deletion still needs success bookkeeping so batch lists remove the finished row.
  it('reports a Delete Anyway success to the caller like a force retry', async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: true }
    mocks.state.removeWorktree
      .mockImplementationOnce(async () => {
        mocks.state.deleteStateByWorktreeId['wt-1'] = {
          isDeleting: false,
          error: 'Archive hook failed for worktree: /w/one — exited 23.',
          canForceDelete: false,
          forceDeleteReason: null,
          canWaiveArchiveHook: true
        }
        return { ok: false, error: 'Archive hook failed for worktree: /w/one — exited 23.' }
      })
      .mockResolvedValueOnce({ ok: true })
    setWorktrees([{ id: 'wt-1', displayName: 'one' }])
    const onDeleted = vi.fn()

    expect(runWorktreeBatchDelete(['wt-1'], { onDeleted })).toBe(true)

    await vi.waitFor(() => expect(showDeleteWorktreeFailureToast).toHaveBeenCalled())
    const toastOptions = vi.mocked(showDeleteWorktreeFailureToast).mock.calls[0]?.[0]
    expect(toastOptions?.canWaiveArchiveHook).toBe(true)
    toastOptions?.onDeleteAnyway()

    await vi.waitFor(() => {
      expect(mocks.state.removeWorktree).toHaveBeenNthCalledWith(
        2,
        { id: 'wt-1', executionHostId: null },
        false,
        { allowFailedArchiveHook: true }
      )
      expect(onDeleted).toHaveBeenCalledWith([{ id: 'wt-1', executionHostId: null }])
    })
  })
})
