import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { toast } from 'sonner'
import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import {
  loadSessionCommitDrafts,
  saveSessionCommitDrafts
} from '@/lib/source-control-commit-draft-session'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('removeWorktree cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    saveSessionCommitDrafts({})
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    mockApi.worktrees.forceDeletePreservedBranch.mockResolvedValue({ deleted: true })
    mockApi.runtimeEnvironments.call.mockReset()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
  })

  it('cleans up all associated state on successful removal', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'tab1', worktreeId }),
          makeTab({ id: 'tab2', worktreeId, sortOrder: 1 })
        ]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      deleteStateByWorktreeId: {
        [worktreeId]: {
          isDeleting: false,
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      },
      fileSearchStateByWorktree: {
        [worktreeId]: {
          query: 'needle',
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
          includePattern: '*.ts',
          excludePattern: 'dist/**',
          results: { files: [], totalMatches: 0, truncated: false },
          resultOwner: null,
          loading: false,
          collapsedFiles: new Set(['/path/wt1/file.ts'])
        }
      },
      activeWorktreeId: worktreeId,
      activeTabId: 'tab1',
      openFiles: [makeOpenFile({ id: '/path/wt1/file.ts', worktreeId })],
      activeFileId: '/path/wt1/file.ts',
      activeTabType: 'editor',
      activeFileIdByWorktree: { [worktreeId]: '/path/wt1/file.ts' },
      activeTabTypeByWorktree: { [worktreeId]: 'editor' },
      rightSidebarExplorerViewByWorktree: { [worktreeId]: 'search' }
    })
    saveSessionCommitDrafts({
      [worktreeId]: 'feat: stale draft',
      'repo1::/path/wt2': 'fix: keep draft'
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    const s = store.getState()

    expect(result).toEqual({ ok: true })
    expect(s.worktreesByRepo['repo1']).toEqual([])
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.ptyIdsByTabId['tab2']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab2']).toBeUndefined()
    expect(s.deleteStateByWorktreeId[worktreeId]).toBeUndefined()
    expect(s.fileSearchStateByWorktree[worktreeId]).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.openFiles).toEqual([])
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeFileIdByWorktree[worktreeId]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[worktreeId]).toBeUndefined()
    expect(s.rightSidebarExplorerViewByWorktree[worktreeId]).toBeUndefined()
    expect(loadSessionCommitDrafts()).toEqual({ 'repo1::/path/wt2': 'fix: keep draft' })
  })

  it('warns when workspace removal keeps the local branch', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    mockApi.worktrees.remove.mockResolvedValueOnce({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            displayName: 'Review cleanup'
          })
        ]
      }
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({
      ok: true,
      preservedBranch: { branchName: 'feature/test', head: 'def456', hostId: 'local' }
    })
    expect(toast.warning).toHaveBeenCalledWith('Worktree deleted, branch kept', {
      id: 'preserved-branch:feature/test:def456',
      description: expect.anything(),
      dismissible: true,
      duration: Infinity
    })
  })

  it('can suppress preserved branch warning toasts for batched cleanup removal', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    mockApi.worktrees.remove.mockResolvedValueOnce({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            displayName: 'Review cleanup'
          })
        ]
      }
    })

    const result = await store
      .getState()
      .removeWorktree({ id: worktreeId, executionHostId: null }, false, {
        suppressPreservedBranchToast: true
      })

    expect(result).toEqual({
      ok: true,
      preservedBranch: { branchName: 'feature/test', head: 'def456', hostId: 'local' }
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('sets delete state with dirty/untracked error and canForceDelete=true on failure', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const error = 'Worktree has uncommitted or untracked changes.'

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab1', worktreeId })] },
      ptyIdsByTabId: { tab1: ['pty1'] },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeId: worktreeId,
      activeTabId: 'tab1'
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    const s = store.getState()

    expect(result).toEqual({ ok: false, error })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true,
      forceDeleteReason: 'dirty'
    })
    // State NOT cleaned up
    expect(s.worktreesByRepo['repo1']).toHaveLength(1)
    expect(s.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(s.ptyIdsByTabId['tab1']).toEqual(['pty1'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(s.activeWorktreeId).toBe(worktreeId)
  })

  it('marks multiple worktrees deleting in one optimistic state update', () => {
    const store = createTestStore()
    const first = 'repo1::/path/wt1'
    const second = 'repo1::/path/wt2'

    seedStore(store, {
      deleteStateByWorktreeId: {
        [first]: {
          isDeleting: false,
          error: 'old failure',
          canForceDelete: true,
          forceDeleteReason: 'dirty'
        }
      }
    })

    store.getState().markWorktreesDeleting([first, second, first])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      [first]: { isDeleting: true, error: null, canForceDelete: false },
      [second]: { isDeleting: true, error: null, canForceDelete: false }
    })
  })

  it('tracks and clears same-id deletion state independently by host', () => {
    const store = createTestStore()
    const local = { id: 'repo1::/path/shared', hostId: 'local' as const }
    const remote = { id: local.id, hostId: 'ssh:box' as const }

    store.getState().markWorktreesDeleting([local, remote])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      [getWorktreeHostIdentity(local)]: { isDeleting: true, executionHostId: 'local' },
      [getWorktreeHostIdentity(remote)]: { isDeleting: true, executionHostId: 'ssh:box' }
    })

    store.getState().clearWorktreeDeleteState(local.id, local.hostId)

    expect(store.getState().deleteStateByWorktreeId[getWorktreeHostIdentity(local)]).toBeUndefined()
    expect(store.getState().deleteStateByWorktreeId[getWorktreeHostIdentity(remote)]).toMatchObject(
      {
        isDeleting: true,
        executionHostId: 'ssh:box'
      }
    )
  })

  it('promotes a queued row to deleting when a real delete starts (phase-aware skip guard)', () => {
    const store = createTestStore()
    const queued = 'repo1::/path/queued'
    const inProgress = 'repo1::/path/in-progress'

    seedStore(store, {
      deleteStateByWorktreeId: {
        [queued]: {
          isDeleting: true,
          phase: 'queued',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        },
        [inProgress]: {
          isDeleting: true,
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })

    store.getState().markWorktreesDeleting([queued, inProgress])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      // A queued row is promoted so the sidebar shows real deletion progress.
      [queued]: { isDeleting: true, phase: 'deleting', error: null, canForceDelete: false },
      // A row already in the deleting phase is left untouched.
      [inProgress]: { isDeleting: true, phase: 'deleting', error: null, canForceDelete: false }
    })
  })

  it('marks multiple worktrees queued for deletion in one optimistic state update', () => {
    const store = createTestStore()
    const first = 'repo1::/path/wt1'
    const second = 'repo1::/path/wt2'

    seedStore(store, {
      deleteStateByWorktreeId: {
        [first]: {
          isDeleting: false,
          error: 'old failure',
          canForceDelete: true,
          forceDeleteReason: 'dirty'
        }
      }
    })

    store.getState().markWorktreesQueuedForDeletion([first, second, first])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      [first]: { isDeleting: true, phase: 'queued', error: null, canForceDelete: false },
      [second]: { isDeleting: true, phase: 'queued', error: null, canForceDelete: false }
    })
  })

  it('keeps active deletion state when cleanup queues stale rows', () => {
    const store = createTestStore()
    const active = 'repo1::/path/deleting'
    const queued = 'repo1::/path/queued'

    seedStore(store, {
      deleteStateByWorktreeId: {
        [active]: {
          isDeleting: true,
          phase: 'deleting',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })

    store.getState().markWorktreesQueuedForDeletion([active, queued])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      [active]: { isDeleting: true, phase: 'deleting', error: null, canForceDelete: false },
      [queued]: { isDeleting: true, phase: 'queued', error: null, canForceDelete: false }
    })
  })

  it('offers force delete for Electron-wrapped local dirty preflight errors', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/workspace/feature-wt'
    const error =
      "Error invoking remote method 'worktrees:remove': Error: Failed to delete worktree at /workspace/feature-wt. ?? scratch.txt"

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true,
      forceDeleteReason: 'dirty'
    })
  })

  it('offers force delete for SSH raw Git dirty removal errors', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/workspace/feature-wt'
    const error =
      "fatal: '/workspace/feature-wt' contains modified or untracked files, use --force to delete it"

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true,
      forceDeleteReason: 'dirty'
    })
  })

  it('does not offer force delete for locked worktree removal errors', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/workspace/feature-wt'
    const error =
      "fatal: cannot remove a locked working tree, lock reason: claude session\nuse 'remove -f -f' to override or unlock first"

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: false,
      forceDeleteReason: null,
      lockReason: null
    })
  })

  it('offers force delete when Git already removed an unregistered worktree', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/workspace/deleted-wt'
    const error =
      "Error invoking remote method 'worktrees:remove': Error: Worktree is no longer registered with Git and its directory is already gone."

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true,
      forceDeleteReason: 'missing-registration'
    })
  })

  it('sets canForceDelete=false when force=true removal fails', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('fatal error'))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store
      .getState()
      .removeWorktree({ id: worktreeId, executionHostId: null }, true)
    const s = store.getState()

    expect(result).toEqual({ ok: false, error: 'fatal error' })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error: 'fatal error',
      canForceDelete: false,
      forceDeleteReason: null
    })
  })

  it('does not offer force delete for protected worktree removal failures', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(
      new Error(
        'Refusing to delete worktree because it contains another registered worktree: /path/wt1/child'
      )
    )

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({
      ok: false,
      error:
        'Refusing to delete worktree because it contains another registered worktree: /path/wt1/child'
    })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error:
        'Refusing to delete worktree because it contains another registered worktree: /path/wt1/child',
      canForceDelete: false,
      forceDeleteReason: null
    })
  })

  it('does not offer force delete when Electron wraps protected removal failures', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'worktrees:remove': Error: Refusing to delete worktree because it contains another registered worktree: /path/wt1/child"
      )
    )

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result.ok).toBe(false)
    expect(store.getState().deleteStateByWorktreeId[worktreeId]?.canForceDelete).toBe(false)
  })

  it('does not offer force delete when Electron wraps SSH filesystem provider failures', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const error =
      "Error invoking remote method 'worktrees:remove': Error: SSH filesystem provider unavailable"

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: false,
      forceDeleteReason: null
    })
  })

  it.each([
    'Could not connect to the remote Orca runtime.',
    'Remote Orca runtime closed the connection.',
    'Timed out waiting for the remote Orca runtime to respond.'
  ])(
    'does not offer force delete for wrapped remote runtime failure: %s',
    async (runtimeFailure) => {
      const store = createTestStore()
      const worktreeId = 'repo1::/path/wt1'
      const error = `Error invoking remote method 'runtime-environments:call': Error: ${runtimeFailure}`

      mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
        const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (compatibility) {
          return Promise.resolve(compatibility)
        }
        if (args.method === 'repo.hooksCheck') {
          return Promise.resolve({
            id: 'rpc-hooks',
            ok: true,
            result: { hasHooks: false, hooks: null, mayNeedUpdate: false },
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return Promise.reject(new Error(error))
      })

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
        worktreesByRepo: {
          repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', hostId: 'runtime:env-1' })]
        },
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        terminalLayoutsByTabId: {}
      })

      const result = await store
        .getState()
        .removeWorktree({ id: worktreeId, executionHostId: null })

      expect(result).toEqual({ ok: false, error })
      expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
        isDeleting: false,
        error,
        canForceDelete: false,
        forceDeleteReason: null
      })
      expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    }
  )

  it('offers force delete for orphaned Orca worktree directories', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'worktrees:remove': Error: Worktree is no longer registered with Git but its directory remains."
      )
    )

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result.ok).toBe(false)
    expect(store.getState().deleteStateByWorktreeId[worktreeId]?.canForceDelete).toBe(true)
  })

  it('does NOT affect other worktrees', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2', displayName: 'wt2' })
        ]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1 })],
        [wt2]: [makeTab({ id: 'tab2', worktreeId: wt2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      fileSearchStateByWorktree: {
        [wt1]: {
          query: 'old',
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
          includePattern: '',
          excludePattern: '',
          results: { files: [], totalMatches: 0, truncated: false },
          resultOwner: null,
          loading: false,
          collapsedFiles: new Set()
        },
        [wt2]: {
          query: 'keep',
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
          includePattern: '*.md',
          excludePattern: '',
          results: { files: [], totalMatches: 1, truncated: false },
          resultOwner: null,
          loading: false,
          collapsedFiles: new Set(['/path/wt2/notes.md'])
        }
      },
      activeWorktreeId: wt2,
      activeTabId: 'tab2'
    })

    await store.getState().removeWorktree({ id: wt1, executionHostId: null })
    const s = store.getState()

    // wt2 is untouched
    expect(s.tabsByWorktree[wt2]).toHaveLength(1)
    expect(s.tabsByWorktree[wt2][0].id).toBe('tab2')
    expect(s.ptyIdsByTabId['tab2']).toEqual(['pty2'])
    expect(s.terminalLayoutsByTabId['tab2']).toEqual(makeLayout())
    expect(s.fileSearchStateByWorktree[wt2]?.query).toBe('keep')
    expect(s.activeWorktreeId).toBe(wt2)
    expect(s.activeTabId).toBe('tab2')

    // wt1 is gone
    expect(s.worktreesByRepo['repo1'].find((w) => w.id === wt1)).toBeUndefined()
    expect(s.tabsByWorktree[wt1]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.fileSearchStateByWorktree[wt1]).toBeUndefined()
  })

  it('shuts down terminals after the backend confirms worktree removal', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const callOrder: string[] = []

    mockApi.pty.kill.mockImplementationOnce(async () => {
      callOrder.push('kill')
    })
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      callOrder.push('remove')
    })

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab1', worktreeId })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({ ok: true })
    expect(callOrder).toEqual(['remove', 'kill'])
  })
})
