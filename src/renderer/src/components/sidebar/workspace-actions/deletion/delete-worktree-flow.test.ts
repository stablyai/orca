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

vi.mock('@/store/slices/worktrees/listing/worktree-catalog-index', () => ({
  getIndexedAllWorktrees: () => Array.from(mocks.state.worktreeMap.values()),
  getIndexedWorktreeMap: () => mocks.state.worktreeMap
}))
vi.mock('@/store/workspaces/selection/worktree-on-host-selector', () => ({
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

describe('Delete from Home of a workspace this desktop runs (REG-8)', () => {
  beforeEach(() => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.state.openModal.mockClear()
    mocks.state.clearWorktreeDeleteState.mockClear()
    mocks.state.deleteStateByWorktreeId = {}
    mocks.state.worktreeLineageById = {}
    mocks.state.repos = []
    vi.mocked(toast.error).mockClear()
  })

  it('after an Unarchive from Home, Delete opens a dialog whose confirm resolves the same row', async () => {
    const { deleteFromHome, unarchiveFromHome } =
      await import('@/components/cloud-workspaces/cloud-workspace-home-archive')
    const { workspace } =
      await import('@/components/cloud-workspaces/cloud-workspaces.test-fixture')
    const { readWorktreeDeleteIdentities, resolveWorktreeBatchDeleteTargets } =
      await import('./worktree-delete-request')
    const cloudHost: ExecutionHostId = 'runtime:env-cloud'
    setWorktrees([{ id: 'wt-cloud', instanceId: 'inst-2', hostId: cloudHost }])
    vi.stubGlobal('window', {
      api: {
        cloudWorkspaces: {
          localWorkspaces: async () => [{ sandboxId: 'sbx_1', worktreeId: 'wt-cloud' }]
        }
      }
    })
    const w = workspace({ id: 'sbx_1' })
    // Unarchive from Home runs this desktop's unarchive (the disk comes back and it wakes).
    const unarchiveLocal = vi.fn(async () => true)
    await unarchiveFromHome(w, 'ik-actions', {
      localWorktreeId: async () => 'wt-cloud',
      patchArchived: vi.fn(),
      archiveLocal: vi.fn(),
      archiveWithUndo: vi.fn(),
      unarchiveLocal
    })
    expect(unarchiveLocal).toHaveBeenCalledWith('wt-cloud')

    await deleteFromHome(w, vi.fn())
    expect(mocks.state.openModal).toHaveBeenCalledTimes(1)
    const [modal, data] = mocks.state.openModal.mock.calls[0]!
    expect(modal).toBe('delete-worktree')
    // The confirmed row's host and instance ride along; a bare { worktreeId } resolved to nothing.
    const identities = readWorktreeDeleteIdentities(data.worktreeDeleteIdentities)
    expect(identities).toEqual([{ id: 'wt-cloud', instanceId: 'inst-2', hostId: cloudHost }])
    // What the dialog's Delete does: resolve the confirmed targets against the current list.
    const { makeWorktree } =
      await import('../../worktree-list/listing/worktree-list-lineage-card-test-fixtures')
    const row = {
      ...makeWorktree({
        id: 'wt-cloud',
        displayName: 'ik-actions',
        branch: 'ik-actions',
        sortOrder: 0,
        instanceId: 'inst-2'
      }),
      hostId: cloudHost
    }
    const targets = resolveWorktreeBatchDeleteTargets(identities, (id, hostId) =>
      id === row.id && hostId === row.hostId ? row : undefined
    )
    expect(targets?.map((t) => t.id)).toEqual(['wt-cloud'])
    expect(toast.error).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('Delete from Home with a runtime record but no sidebar row (REG-8b)', () => {
  beforeEach(() => {
    mocks.state.openModal.mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
  })

  it('after a re-sign-in (record, no row): confirm, then the control plane deletes it', async () => {
    const { deleteFromHome } =
      await import('@/components/cloud-workspaces/cloud-workspace-home-archive')
    const { workspace } =
      await import('@/components/cloud-workspaces/cloud-workspaces.test-fixture')
    // Main still has this desktop's runtime record; this window has no row for it.
    setWorktrees([])
    vi.stubGlobal('window', {
      api: {
        cloudWorkspaces: {
          localWorkspaces: async () => [
            { sandboxId: 'sbx_1', worktreeId: 'wt-gone', runtimeEnvironmentId: 'env-cloud' }
          ]
        }
      }
    })
    const w = workspace({ id: 'sbx_1' })
    const confirmDelete = vi.fn()
    await deleteFromHome(w, confirmDelete)
    // Not the sidebar funnel (which would toast "Workspace list changed" and delete nothing).
    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(confirmDelete).toHaveBeenCalledWith({ kind: 'delete', workspace: w })
    vi.unstubAllGlobals()
  })

  it('with the row present it is still this desktop’s own delete dialog', async () => {
    const { deleteFromHome } =
      await import('@/components/cloud-workspaces/cloud-workspace-home-archive')
    const { workspace } =
      await import('@/components/cloud-workspaces/cloud-workspaces.test-fixture')
    setWorktrees([{ id: 'wt-here', hostId: 'runtime:env-cloud' }])
    vi.stubGlobal('window', {
      api: {
        cloudWorkspaces: {
          localWorkspaces: async () => [
            { sandboxId: 'sbx_2', worktreeId: 'wt-here', runtimeEnvironmentId: 'env-cloud' }
          ]
        }
      }
    })
    const confirmDelete = vi.fn()
    await deleteFromHome(workspace({ id: 'sbx_2' }), confirmDelete)
    expect(confirmDelete).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'delete-worktree',
      expect.objectContaining({ worktreeId: 'wt-here' })
    )
    vi.unstubAllGlobals()
  })
})

vi.mock('@/lib/orca-cloud/cloud-primary-delete-request', () => ({
  requestCloudPrimaryDelete: vi.fn()
}))

describe('Delete on a cloud workspace on its default branch (CLOUD-PRIMARY-DELETE)', () => {
  beforeEach(async () => {
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.state.openModal.mockClear()
    mocks.state.repos = []
    const { requestCloudPrimaryDelete } =
      await import('@/lib/orca-cloud/cloud-primary-delete-request')
    vi.mocked(requestCloudPrimaryDelete).mockClear()
  })

  async function pairWith(environmentId: string): Promise<void> {
    vi.stubGlobal('window', {
      api: {
        cloudWorkspaces: {
          localWorkspaces: async () => [],
          environmentBindings: async () => ({ sbx_paired: { environmentId } })
        }
      }
    })
    const { refreshCloudWorktreeBindings } =
      await import('@/components/cloud-workspaces/cloud-workspace-identity')
    await refreshCloudWorktreeBindings()
  }

  it('a paired cloud workspace is deletable: the cloud delete dialog, never "Remove Project"', async () => {
    await pairWith('env-cloud')
    const { runWorktreeDelete } = await import('./delete-worktree-flow')
    const { requestCloudPrimaryDelete } =
      await import('@/lib/orca-cloud/cloud-primary-delete-request')
    setWorktrees([{ id: 'wt-main', isMainWorktree: true, hostId: 'runtime:env-cloud' }])
    runWorktreeDelete('wt-main', { expectedHostId: 'runtime:env-cloud' })
    expect(requestCloudPrimaryDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wt-main', hostId: 'runtime:env-cloud' })
    )
    expect(mocks.state.openModal).not.toHaveBeenCalledWith(
      'confirm-remove-folder',
      expect.anything()
    )
    vi.unstubAllGlobals()
  })

  it('a local primary checkout still cannot be deleted: it offers removing the project', async () => {
    await pairWith('env-cloud')
    const { runWorktreeDelete } = await import('./delete-worktree-flow')
    const { requestCloudPrimaryDelete } =
      await import('@/lib/orca-cloud/cloud-primary-delete-request')
    setWorktrees([{ id: 'wt-local-main', isMainWorktree: true }])
    runWorktreeDelete('wt-local-main')
    expect(requestCloudPrimaryDelete).not.toHaveBeenCalled()
    expect(mocks.state.openModal).toHaveBeenCalledWith(
      'confirm-remove-folder',
      expect.objectContaining({ repoId: 'repo-1' })
    )
    vi.unstubAllGlobals()
  })
})
