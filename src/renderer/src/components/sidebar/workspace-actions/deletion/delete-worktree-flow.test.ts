import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

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

vi.mock('@/components/editor/model-lifetime/identity/editor-model-owner', () => ({
  resolveEditorModelOwner: () => ({ environmentId: null, hostId: 'local' }),
  getEditorModelOwnerKey: () => ''
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
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

import { runWorktreeDeletesInParallel } from './worktree-delete-execution'

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
})
