/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildWorktreeComparator } from '@/components/sidebar/smart-sort'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { toast } from 'sonner'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn())
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

// Mock window.api before anything uses it
const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  runtimeEnvironments: {
    call: vi.fn()
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { buildOrphanTerminalCleanupPatch } from './terminal-orphan-helpers'
import {
  loadSessionCommitDrafts,
  saveSessionCommitDrafts
} from '@/lib/source-control-commit-draft-session'

// ─── Tests ────────────────────────────────────────────────────────────

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
        [worktreeId]: { isDeleting: false, error: null, canForceDelete: false }
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

    const result = await store.getState().removeWorktree(worktreeId)
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({
      ok: true,
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })
    expect(toast.warning).toHaveBeenCalledWith('Worktree deleted, branch kept', {
      id: 'preserved-branch:feature/test:def456',
      description: expect.anything(),
      dismissible: true,
      duration: Infinity
    })
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

    const result = await store.getState().removeWorktree(worktreeId)
    const s = store.getState()

    expect(result).toEqual({ ok: false, error })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true
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
        [first]: { isDeleting: false, error: 'old failure', canForceDelete: true }
      }
    })

    store.getState().markWorktreesDeleting([first, second, first])

    expect(store.getState().deleteStateByWorktreeId).toMatchObject({
      [first]: { isDeleting: true, error: null, canForceDelete: false },
      [second]: { isDeleting: true, error: null, canForceDelete: false }
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true
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

    const result = await store.getState().removeWorktree(worktreeId, true)
    const s = store.getState()

    expect(result).toEqual({ ok: false, error: 'fatal error' })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error: 'fatal error',
      canForceDelete: false
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({
      ok: false,
      error:
        'Refusing to delete worktree because it contains another registered worktree: /path/wt1/child'
    })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error:
        'Refusing to delete worktree because it contains another registered worktree: /path/wt1/child',
      canForceDelete: false
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

    const result = await store.getState().removeWorktree(worktreeId)

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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: false, error })
    expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: false
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
          repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
        },
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        terminalLayoutsByTabId: {}
      })

      const result = await store.getState().removeWorktree(worktreeId)

      expect(result).toEqual({ ok: false, error })
      expect(store.getState().deleteStateByWorktreeId[worktreeId]).toEqual({
        isDeleting: false,
        error,
        canForceDelete: false
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

    const result = await store.getState().removeWorktree(worktreeId)

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
          loading: false,
          collapsedFiles: new Set(['/path/wt2/notes.md'])
        }
      },
      activeWorktreeId: wt2,
      activeTabId: 'tab2'
    })

    await store.getState().removeWorktree(wt1)
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

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: true })
    expect(callOrder).toEqual(['remove', 'kill'])
  })
})

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('does not rewrite sortOrder when selecting a worktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const lastActivityAt = 123456

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            sortOrder: 123,
            lastActivityAt,
            isUnread: false
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(worktreeId)

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.sortOrder).toBe(123)
    expect(worktree.lastActivityAt).toBe(lastActivityAt)
    // Why: selecting a worktree should not manufacture smart-sort activity.
    // Persisted ordering signals come from real background work or edits, not focus.
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('clears unread on selection without manufacturing smart-sort activity', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const lastActivityAt = 123456

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            isUnread: true,
            lastActivityAt
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(worktreeId)

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.isUnread).toBe(false)
    expect(worktree.lastActivityAt).toBe(lastActivityAt)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId,
      updates: { isUnread: false }
    })
  })

  it('does not change smart-sort rank after selection when a background event bumps sortEpoch', () => {
    const store = createTestStore()
    const focusedId = 'repo1::/path/focused'
    const backgroundId = 'repo1::/path/background'
    const now = new Date('2026-04-16T12:00:00.000Z').getTime()

    vi.spyOn(Date, 'now').mockReturnValue(now)

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: focusedId,
            repoId: 'repo1',
            displayName: 'Focused',
            lastActivityAt: now - 2 * 60_000
          }),
          makeWorktree({
            id: backgroundId,
            repoId: 'repo1',
            displayName: 'Background',
            lastActivityAt: now - 60_000
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(focusedId)
    store.getState().bumpWorktreeActivity(backgroundId)

    const worktrees = [...store.getState().worktreesByRepo.repo1]
    const repoMap = new Map(store.getState().repos.map((repo) => [repo.id, repo]))
    worktrees.sort(buildWorktreeComparator('smart', repoMap, now, new Map()))

    expect(worktrees.map((worktree) => worktree.id)).toEqual([backgroundId, focusedId])
  })

  it('keeps the current right sidebar tab when switching worktrees', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      rightSidebarTab: 'checks',
      rightSidebarTabByWorktree: { [wt1]: 'search' as never, [wt2]: 'explorer' }
    })

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarTab).toBe('checks')

    store.getState().setActiveWorktree(wt2)
    expect(store.getState().rightSidebarTab).toBe('checks')

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarTab).toBe('checks')
  })

  it('restores the Explorer files/search subview per worktree when switching', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'
    const wt3 = 'repo1::/path/wt3'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' }),
          makeWorktree({ id: wt3, repoId: 'repo1', path: '/path/wt3' })
        ]
      },
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'search',
      rightSidebarExplorerViewByWorktree: {
        [wt1]: 'search',
        [wt2]: 'files'
      }
    })

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarExplorerView).toBe('search')

    store.getState().setActiveWorktree(wt2)
    expect(store.getState().rightSidebarExplorerView).toBe('files')

    store.getState().setActiveWorktree(wt3)
    expect(store.getState().rightSidebarExplorerView).toBe('files')

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarExplorerView).toBe('search')
  })

  it('does not reset the right sidebar tab for worktrees without remembered sidebar state', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      rightSidebarTab: 'checks'
    })

    store.getState().setActiveWorktree(wt)

    expect(store.getState().rightSidebarTab).toBe('checks')
  })

  it('does not notify subscribers when reselecting the already-active reconciled worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const tabId = 'terminal-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabId: tabId,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: tabId, worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { [tabId]: ['pty-1'] },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: tabId,
            entityId: tabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: tabId,
            tabOrder: [tabId]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId },
      layoutByWorktree: { [wt]: { type: 'leaf', groupId } },
      everActivatedWorktreeIds: new Set([wt]),
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    const before = store.getState()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setActiveWorktree(wt)

    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
  })

  it('does not clobber the current right sidebar tab when clearing the active worktree', () => {
    const store = createTestStore()

    seedStore(store, {
      activeWorktreeId: 'repo1::/path/wt1',
      rightSidebarTab: 'checks',
      rightSidebarTabByWorktree: { 'repo1::/path/wt1': 'search' as never }
    })

    store.getState().setActiveWorktree(null)

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().rightSidebarTab).toBe('checks')
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ 'repo1::/path/wt1': 'search' })
  })

  it('falls back to the worktree browser tab when the restored editor id belongs to a different worktree', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'
    const otherFileId = '/path/wt2/file.ts'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      openFiles: [makeOpenFile({ id: otherFileId, worktreeId: wt2 })],
      activeFileIdByWorktree: { [wt1]: otherFileId },
      browserTabsByWorktree: {
        [wt1]: [
          {
            id: browserTabId,
            worktreeId: wt1,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt1]: browserTabId },
      activeTabTypeByWorktree: { [wt1]: 'editor' }
    })

    store.getState().setActiveWorktree(wt1)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt1)
    expect(s.activeBrowserTabId).toBe(browserTabId)
    expect(s.activeTabType).toBe('browser')
    expect(s.activeFileId).toBeNull()
  })

  it('prefers the unified active tab over stale legacy browser restore state', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const terminalId = 'terminal-1'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'tab-terminal-1',
            entityId: terminalId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'tab-browser-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'tab-terminal-1',
            tabOrder: ['tab-terminal-1', 'tab-browser-1']
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalId)
    expect(s.activeBrowserTabId).toBe(browserTabId)
  })

  it('ignores stale unified tabs and falls back to terminal-first activation for empty groups', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'stale-terminal-tab',
            entityId: 'missing-terminal',
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'stale-terminal-tab',
            tabOrder: ['stale-terminal-tab']
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeBrowserTabId).toBe(browserTabId)
    expect(s.activeTabId).toBeNull()
    expect(s.unifiedTabsByWorktree[wt]).toEqual([])
    expect(s.groupsByWorktree[wt][0].activeTabId).toBeNull()
  })

  it('creates a root tab group when the first terminal opens in a worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const terminal = store.getState().createTab(wt)
    const state = store.getState()
    const groups = state.groupsByWorktree[wt] ?? []
    const unifiedTabs = state.unifiedTabsByWorktree[wt] ?? []

    expect(groups).toHaveLength(1)
    expect(state.activeGroupIdByWorktree[wt]).toBe(groups[0].id)
    expect(state.layoutByWorktree[wt]).toEqual({ type: 'leaf', groupId: groups[0].id })
    expect(unifiedTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminal.id,
          entityId: terminal.id,
          worktreeId: wt,
          groupId: groups[0].id,
          contentType: 'terminal'
        })
      ])
    )
    expect(groups[0].activeTabId).toBe(terminal.id)
    expect(groups[0].tabOrder).toEqual([terminal.id])
  })

  it('stores trimmed quick command labels on terminal and unified tabs', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const labeled = store
      .getState()
      .createTab(wt, undefined, undefined, { quickCommandLabel: '  Run tests  ' })
    const unlabeled = store
      .getState()
      .createTab(wt, undefined, undefined, { quickCommandLabel: '   ' })
    const state = store.getState()

    expect(state.tabsByWorktree[wt].find((tab) => tab.id === labeled.id)?.quickCommandLabel).toBe(
      'Run tests'
    )
    expect(
      state.unifiedTabsByWorktree[wt].find((tab) => tab.entityId === labeled.id)?.quickCommandLabel
    ).toBe('Run tests')
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === unlabeled.id)).not.toHaveProperty(
      'quickCommandLabel'
    )
  })

  it('stamps the Windows default shell onto new terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::/path/wt1'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'cmd.exe' },
        worktreesByRepo: {
          repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt)
      expect(terminal.shellOverride).toBe('cmd.exe')

      store.setState({
        settings: { ...store.getState().settings!, terminalWindowsShell: 'powershell.exe' }
      })
      expect(store.getState().tabsByWorktree[wt][0].shellOverride).toBe('cmd.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('stamps host shell metadata when project runtime overrides stale WSL defaults', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::C:\\repo'

      seedStore(store, {
        settings: {
          ...getDefaultSettings('/tmp'),
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        },
        projects: [
          {
            id: 'project-1',
            displayName: 'Project',
            badgeColor: '#000',
            sourceRepoIds: ['repo1'],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              projectId: 'project-1',
              path: 'C:\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'wsl.exe')
      expect(terminal.shellOverride).toBe('powershell.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('stamps WSL shell metadata when project runtime overrides host defaults', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::C:\\repo'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' },
        projects: [
          {
            id: 'project-1',
            displayName: 'Project',
            badgeColor: '#000',
            sourceRepoIds: ['repo1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              projectId: 'project-1',
              path: 'C:\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBe('wsl.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('uses WSL as the default shell for WSL worktree terminals on Windows', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::/wsl/path'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' },
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt)
      expect(terminal.shellOverride).toBe('wsl.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('does not stamp local Windows shell icons onto SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('preserves explicit Windows shell selections for Windows SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              remotePlatform: 'win32'
            }
          ]
        ]),
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBe('cmd.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('drops explicit Windows shell selections for non-Windows SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              remotePlatform: 'linux'
            }
          ]
        ]),
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('does not offer Git Bash as a local shell override for SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'git-bash' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'git-bash')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('publishes the first terminal and root tab group atomically', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const snapshots: { terminalCount: number; unifiedCount: number; groupCount: number }[] = []
    const unsubscribe = store.subscribe((state) => {
      snapshots.push({
        terminalCount: state.tabsByWorktree[wt]?.length ?? 0,
        unifiedCount: state.unifiedTabsByWorktree[wt]?.length ?? 0,
        groupCount: state.groupsByWorktree[wt]?.length ?? 0
      })
    })

    store.getState().createTab(wt)
    unsubscribe()

    // Why: task-page launches queue startup/setup commands before React mounts.
    // A terminal-only intermediate state can mount the legacy host and race
    // the split-group host, duplicating setup panes and PTYs.
    expect(snapshots).toEqual([{ terminalCount: 1, unifiedCount: 1, groupCount: 1 }])
  })

  it('syncs the global active surface when focusing a different split group', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const editorFileId = '/path/wt1/src/index.ts'
    const terminalGroupId = 'group-terminal'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId: terminalGroupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: terminalGroupId,
            worktreeId: wt,
            activeTabId: terminalTabId,
            tabOrder: [terminalTabId]
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: terminalGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: terminalGroupId }
    })

    store.getState().focusGroup(wt, editorGroupId)

    const s = store.getState()
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
    expect(s.activeTabId).toBe(terminalTabId)
  })

  it('promotes the next tab in the focused split into the global active surface on close', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const browserTabId = 'browser-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      activeBrowserTabId: browserTabId,
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'browser-view-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser',
            label: 'Example'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'browser-view-1',
            tabOrder: [terminalTabId, 'browser-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().closeBrowserTab(browserTabId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(terminalTabId)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalTabId)
    expect(s.activeBrowserTabId).toBeNull()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('promotes the sibling group into the global active surface when closing a focused empty split', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const editorFileId = '/path/wt1/src/index.ts'
    const emptyGroupId = 'group-empty'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: emptyGroupId,
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: emptyGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: emptyGroupId }
    })

    store.getState().closeEmptyGroup(wt, emptyGroupId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.map((group) => group.id)).toEqual([editorGroupId])
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
  })

  it('reuses the lowest available terminal number after closes', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt)

    expect(first.title).toBe('Terminal 1')
    expect(second.title).toBe('Terminal 2')

    store.getState().closeTab(first.id)
    store.getState().closeTab(second.id)

    const replacement = store.getState().createTab(wt)
    expect(replacement.title).toBe('Terminal 1')
  })

  it('preserves cleanup-owned references when there are no orphan terminals', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'terminal-1',
            entityId: 'terminal-1',
            worktreeId: wt,
            groupId: 'group-1'
          })
        ]
      },
      ptyIdsByTabId: {
        'terminal-1': []
      },
      activeTabId: 'terminal-1',
      activeTabIdByWorktree: {
        [wt]: 'terminal-1'
      }
    })

    const state = store.getState()
    const patch = buildOrphanTerminalCleanupPatch(state, wt, new Set())
    const referenceKeys = [
      'tabsByWorktree',
      'ptyIdsByTabId',
      'runtimePaneTitlesByTabId',
      'expandedPaneByTabId',
      'canExpandPaneByTabId',
      'terminalLayoutsByTabId',
      'pendingStartupByTabId',
      'pendingSetupSplitByTabId',
      'pendingIssueCommandSplitByTabId',
      'tabBarOrderByWorktree',
      'cacheTimerByKey',
      'activeTabIdByWorktree'
    ] as const

    for (const key of referenceKeys) {
      expect(patch[key]).toBe(state[key])
    }
    expect(patch.activeTabId).toBe(state.activeTabId)
  })

  it('removes orphan terminal caches while creating a replacement tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      ptyIdsByTabId: {
        [orphanId]: []
      },
      runtimePaneTitlesByTabId: {
        [orphanId]: { 1: 'stale' }
      },
      terminalLayoutsByTabId: {
        [orphanId]: makeLayout()
      },
      pendingStartupByTabId: {
        [orphanId]: { command: 'codex' }
      },
      tabBarOrderByWorktree: {
        [wt]: [orphanId]
      },
      cacheTimerByKey: {
        [`${orphanId}:seed`]: 123
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const replacement = store.getState().createTab(wt)
    const s = store.getState()

    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([replacement.id])
    expect(s.ptyIdsByTabId[orphanId]).toBeUndefined()
    expect(s.runtimePaneTitlesByTabId[orphanId]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[orphanId]).toBeUndefined()
    expect(s.pendingStartupByTabId[orphanId]).toBeUndefined()
    expect(s.cacheTimerByKey[`${orphanId}:seed`]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[replacement.id]).toEqual(makeLayout())
  })

  it('clears orphan active terminal state while creating an inactive replacement tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId]
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const replacement = store.getState().createTab(wt, undefined, undefined, { activate: false })
    const s = store.getState()

    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([replacement.id])
    expect(s.activeTabId).toBeNull()
    expect(s.activeTabIdByWorktree[wt]).toBe(replacement.id)
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(replacement.id)
    expect(s.groupsByWorktree[wt]?.[0]?.tabOrder).toEqual([replacement.id])
  })

  it('uses cleanup active fallback when inactive creation removes an orphan active tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: existingId,
            tabOrder: [existingId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const s = store.getState()

    expect(s.activeTabId).toBeNull()
    expect(s.activeTabIdByWorktree[wt]).toBe(existingId)
    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([existingId, created.id])
    expect(s.groupsByWorktree[wt]?.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })

  it('keeps surviving target-group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const created = store.getState().createTab(wt, 'group-1', undefined, { activate: false })
    const s = store.getState()

    expect(s.activeTabIdByWorktree[wt]).toBe(existingId)
    expect(s.groupsByWorktree[wt]?.[0]).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId, created.id],
      recentTabIds: [existingId]
    })
  })

  it('keeps inactive terminal creation active state scoped to the target group', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: existingId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: existingId,
            tabOrder: [existingId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [existingId]: []
      },
      activeTabId: existingId,
      activeTabIdByWorktree: {
        [wt]: existingId
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(store.getState().activeTabIdByWorktree[wt]).toBe(existingId)
    expect(groups.find((group) => group.id === 'group-a')?.activeTabId).toBe(existingId)
    expect(groups.find((group) => group.id === 'group-b')?.activeTabId).toBe(created.id)
    expect(groups.find((group) => group.id === 'group-b')?.tabOrder).toEqual([created.id])
  })

  it('clears orphan terminal state from non-target groups during tab creation', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId],
            recentTabIds: [orphanId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: []
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(groups.find((group) => group.id === 'group-a')).toMatchObject({
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    })
    expect(groups.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })

  it('keeps surviving non-target group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(groups.find((group) => group.id === 'group-a')).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId],
      recentTabIds: [existingId]
    })
    expect(groups.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })

  // Why: unread flags are ephemeral UI state — they must not linger past the
  // lifetime of the tab/pane they point at. A stale flag on a closed tab
  // would render a bell the user can never dismiss because the tab (and
  // therefore every focus path that clears it) is gone.
  it('drops unreadTerminalTabs for a closed tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const closing = store.getState().createTab(wt)
    const surviving = store.getState().createTab(wt)

    // Seed flags directly — the self-guarded mark actions intentionally
    // refuse the currently-active tab, but this test's subject is closeTab's
    // cleanup behavior, not the guards.
    store.setState({
      unreadTerminalTabs: {
        [closing.id]: true as const,
        [surviving.id]: true as const
      }
    })

    store.getState().closeTab(closing.id)

    const s = store.getState()
    expect(s.unreadTerminalTabs[closing.id]).toBeUndefined()
    // Siblings untouched.
    expect(s.unreadTerminalTabs[surviving.id]).toBe(true)
  })

  // Why: shutdownWorktreeTerminals tears down every PTY in the worktree. The
  // focus events that would normally clear unread (bell-in-focused-pane,
  // activate-tab) never arrive for dead PTYs, so the flags have to be
  // dropped by the shutdown path itself.
  it('drops unread flags for every tab in a shutdown worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const tabA = store.getState().createTab(wt)
    const tabB = store.getState().createTab(wt)

    // Seed flags directly (see closeTab test for why).
    store.setState({
      unreadTerminalTabs: {
        [tabA.id]: true as const,
        [tabB.id]: true as const
      }
    })

    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.unreadTerminalTabs[tabA.id]).toBeUndefined()
    expect(s.unreadTerminalTabs[tabB.id]).toBeUndefined()
  })

  // Why: ownership regression (design §1.3). shutdownWorktreeTerminals used to
  // delete browserTabsByWorktree[worktreeId] and reset
  // activeBrowserTabId/activeTabType as a side effect — now those mutations
  // belong exclusively to shutdownWorktreeBrowsers. If a refactor reintroduces
  // the side effect, both thunks will write the same keys and race.
  it('leaves browser state untouched when shutting down terminals', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeBrowserTabId: 'workspace-1',
      activeTabType: 'browser',
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'workspace-1',
            worktreeId: wt,
            label: 'ws1',
            sessionProfileId: null,
            pageIds: [],
            activePageId: null,
            url: 'about:blank',
            title: 'ws1',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as never,
      activeBrowserTabIdByWorktree: { [wt]: 'workspace-1' }
    })

    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.browserTabsByWorktree[wt]).toBeDefined()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBe('workspace-1')
    expect(s.activeBrowserTabId).toBe('workspace-1')
    expect(s.activeTabType).toBe('browser')
  })

  it('returns to the landing state when closing the last terminal tab in the active worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const tabId = 'tab-1'
    const unifiedTabId = 'unified-tab-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabId: tabId,
      activeTabType: 'terminal',
      activeTabIdByWorktree: { [wt]: tabId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: tabId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: unifiedTabId,
            entityId: tabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal',
            label: 'Terminal 1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: unifiedTabId,
            tabOrder: [unifiedTabId]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      }
    })

    store.getState().closeTab(tabId)

    const s = store.getState()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.tabsByWorktree[wt]).toEqual([])
    expect(s.unifiedTabsByWorktree[wt]).toEqual([])
  })

  it('keeps terminal numbering stable when a live agent renames an existing tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')

    const second = store.getState().createTab(wt)

    expect(store.getState().tabsByWorktree[wt]?.[0]).toMatchObject({
      id: first.id,
      title: 'Claude Code',
      defaultTitle: 'Terminal 1'
    })
    expect(second.title).toBe('Terminal 2')
    expect(second.defaultTitle).toBe('Terminal 2')
  })

  it('falls back to the stable terminal label when a live title clears', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    store.getState().updateTabTitle(first.id, '')

    expect(store.getState().tabsByWorktree[wt]?.[0]).toMatchObject({
      id: first.id,
      title: 'Terminal 1',
      defaultTitle: 'Terminal 1'
    })
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[wt]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === first.id
        )
    ).toMatchObject({
      label: 'Terminal 1'
    })
  })

  it('preserves terminal and unified tab map references when a live title repeats', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    const tabsByWorktree = store.getState().tabsByWorktree
    const unifiedTabsByWorktree = store.getState().unifiedTabsByWorktree
    const sortEpoch = store.getState().sortEpoch

    store.getState().updateTabTitle(first.id, 'Claude Code')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().unifiedTabsByWorktree).toBe(unifiedTabsByWorktree)
    expect(store.getState().sortEpoch).toBe(sortEpoch)
  })

  it('repairs a stale unified tab label when a live title repeats', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    const tabsByWorktree = store.getState().tabsByWorktree
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [wt]: state.unifiedTabsByWorktree[wt].map((tab) =>
          tab.contentType === 'terminal' && tab.entityId === first.id
            ? { ...tab, label: 'stale' }
            : tab
        )
      }
    }))

    store.getState().updateTabTitle(first.id, 'Claude Code')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[wt]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === first.id
        )?.label
    ).toBe('Claude Code')
  })

  it('clears stale background browser tab type when closing the last browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: null,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'browser-1',
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    store.getState().closeBrowserTab('browser-1')

    expect(store.getState().activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(store.getState().activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('falls back to editor globally when closing the last active browser tab in a worktree with files', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const fileId = '/path/wt1/src/index.ts'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      openFiles: [makeOpenFile({ id: fileId, worktreeId: wt, filePath: fileId })],
      activeFileId: fileId,
      activeFileIdByWorktree: { [wt]: fileId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'browser-1',
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabId: 'browser-1',
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' }
    })

    store.getState().closeBrowserTab('browser-1')

    const s = store.getState()
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(fileId)
  })

  it('does not switch the global surface when creating a browser tab for a background worktree', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })

    const browserTab = store
      .getState()
      .createBrowserTab(backgroundWt, 'https://example.com', { activate: true })

    const s = store.getState()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[backgroundWt]).toBe('browser')
    expect(s.activeBrowserTabIdByWorktree[backgroundWt]).toBe(browserTab.id)
  })

  it('queues and consumes a one-shot address-bar focus request for a fresh blank browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      }
    })

    const browserTab = store.getState().createBrowserTab(wt, 'about:blank', { activate: true })

    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBe(true)
    expect(store.getState().consumeAddressBarFocusRequest(browserTab.id)).toBe(true)
    expect(store.getState().consumeAddressBarFocusRequest(browserTab.id)).toBe(false)
  })

  it('does not queue address-bar focus for background or already-navigated browser tabs', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })

    const backgroundBlankTab = store
      .getState()
      .createBrowserTab(backgroundWt, 'about:blank', { activate: true })
    const activeNavigatedTab = store
      .getState()
      .createBrowserTab(activeWt, 'https://example.com', { activate: true })

    expect(store.getState().pendingAddressBarFocusByTabId[backgroundBlankTab.id]).toBeUndefined()
    expect(store.getState().pendingAddressBarFocusByTabId[activeNavigatedTab.id]).toBeUndefined()
  })

  it('drops a pending address-bar focus request when the new browser tab closes before mount', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      }
    })

    const browserTab = store.getState().createBrowserTab(wt, 'about:blank', { activate: true })
    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBe(true)

    store.getState().closeBrowserTab(browserTab.id)

    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBeUndefined()
  })

  it('restores terminal surface when switching to a worktree that was last on a terminal tab with open files', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const fileId = '/path/wt1/src/index.ts'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: null,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      openFiles: [makeOpenFile({ id: fileId, worktreeId: wt, filePath: fileId })],
      activeFileIdByWorktree: { [wt]: fileId },
      // User was on the terminal, not the editor
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    // File ID should still be tracked for background state
    expect(s.activeFileId).toBe(fileId)
  })
})

// Why: sleep (`shutdownWorktreeTerminals(wt, { keepIdentifiers: true })`)
// kills the PTYs but preserves wake hints (tab.ptyId, ptyIdsByLeafId, the
// runtime pane titles) so wake can reattach to the same daemon-history dir
// or relay session. Before the sleep-statuses fix, the live agent-status
// rows were also preserved — so a Claude that was mid-turn at sleep time
// kept its row in the inline agents list as "working" until the 30-min
// stale TTL decayed it. Sleep now drops live entries and retained `done`
// snapshots for the whole worktree, so the card folds to a single grey signal.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.pty.kill.mockResolvedValue(undefined)
    shutdownBufferCaptures.clear()
  })

  it('automatically hibernates only the completed agent pane and preserves siblings', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`
    const siblingPaneKey = `tab-1:${siblingLeaf}`
    const dropByWorktree = vi.fn()

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: targetLeaf },
            second: { type: 'leaf', leafId: siblingLeaf }
          },
          activeLeafId: siblingLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent', [siblingLeaf]: 'pty-shell' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] },
      unreadTerminalTabs: { 'tab-1': true },
      unreadTerminalPanes: { [targetPaneKey]: true, [siblingPaneKey]: true },
      unreadAgentCompletionPanes: { [targetPaneKey]: true, [siblingPaneKey]: true },
      lastTerminalInputAtByPaneKey: { [targetPaneKey]: 1000, [siblingPaneKey]: 1100 },
      pendingSetupSplitByTabId: { 'tab-1': { command: 'setup', direction: 'horizontal' } },
      pendingIssueCommandSplitByTabId: { 'tab-1': { command: 'issue' } }
    })
    store.setState({ dropAgentStatusByWorktree: dropByWorktree as never })
    store.getState().setAgentStatus(
      targetPaneKey,
      {
        state: 'done',
        prompt: 'resume target',
        agentType: 'codex',
        lastAssistantMessage: 'done'
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )
    store
      .getState()
      .setAgentStatus(
        siblingPaneKey,
        { state: 'working', prompt: 'keep running', agentType: 'claude' },
        'Claude',
        { updatedAt: 2100, stateStartedAt: 2100 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'sibling-session' } }
      )
    const siblingSleepingRecordBefore =
      store.getState().sleepingAgentSessionsByPaneKey[siblingPaneKey]

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'pty-agent'
    })

    const state = store.getState()
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    expect(mockApi.pty.kill).not.toHaveBeenCalledWith('pty-shell', expect.anything())
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith(['pty-agent'])
    expect(mockUnregisterPtyDataHandlers.mock.invocationCallOrder[0]).toBeLessThan(
      mockApi.pty.kill.mock.invocationCallOrder[0]
    )
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-shell'])
    expect(state.tabsByWorktree[wt]?.[0]?.ptyId).toBe('pty-shell')
    expect(state.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      [targetLeaf]: 'pty-agent',
      [siblingLeaf]: 'pty-shell'
    })
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'target-session' }
    })
    expect(state.sleepingAgentSessionsByPaneKey[siblingPaneKey]).toBe(siblingSleepingRecordBefore)
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.agentStatusByPaneKey[siblingPaneKey]).toBeDefined()
    expect(state.retainedAgentsByPaneKey[targetPaneKey]).toMatchObject({
      entry: { lastAssistantMessage: 'done' }
    })
    expect(state.unreadTerminalTabs['tab-1']).toBe(true)
    expect(state.unreadTerminalPanes[targetPaneKey]).toBeUndefined()
    expect(state.unreadTerminalPanes[siblingPaneKey]).toBe(true)
    expect(state.unreadAgentCompletionPanes[targetPaneKey]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[siblingPaneKey]).toBe(true)
    expect(state.lastTerminalInputAtByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.lastTerminalInputAtByPaneKey[siblingPaneKey]).toBe(1100)
    expect(state.pendingSetupSplitByTabId['tab-1']).toBeDefined()
    expect(state.pendingIssueCommandSplitByTabId['tab-1']).toBeDefined()
    expect(dropByWorktree).not.toHaveBeenCalled()
  })

  it('keeps manual sleep worktree-wide', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Terminal', ptyId: 'pty-agent' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-agent', { keepHistory: true })
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-shell', { keepHistory: true })
  })

  it('does not commit pane sleep state when local target kill fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`
    const handlerSnapshots = [{ ptyId: 'pty-agent' }]

    mockApi.pty.kill.mockRejectedValueOnce(new Error('kill failed'))
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: targetLeaf },
            second: { type: 'leaf', leafId: siblingLeaf }
          },
          activeLeafId: siblingLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent', [siblingLeaf]: 'pty-shell' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-shell'] }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'pty-agent'
      })
    ).rejects.toThrow('kill failed')

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual(['pty-agent', 'pty-shell'])
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
    expect(state.suppressedPtyExitIds['pty-agent']).toBeUndefined()
    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith(handlerSnapshots)
  })

  it('uses target-only runtime stop for automatic pane hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['terminal-1'],
                  livePtyIds: ['terminal-1', 'terminal-2'],
                  postStopVerified: true,
                  remainingLivePtyIds: ['terminal-2']
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: targetLeaf },
            second: { type: 'leaf', leafId: siblingLeaf }
          },
          activeLeafId: siblingLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [targetLeaf]: 'remote:env-1@@terminal-1',
            [siblingLeaf]: 'remote:env-1@@terminal-2'
          }
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:env-1@@terminal-1', 'remote:env-1@@terminal-2']
      }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'remote:env-1@@terminal-1',
      expectedRuntimePtyId: 'terminal-1'
    })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.stopExact',
        params: expect.objectContaining({
          expectedPtyIds: ['terminal-1'],
          keepHistory: true,
          targetOnly: true
        })
      })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['remote:env-1@@terminal-2'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('clears stale relay wake hints when pane hibernation leaves no live PTYs in the tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({
            id: 'tab-1',
            worktreeId: wt,
            title: 'Codex',
            ptyId: 'ssh:ssh-1@@pty-agent'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'ssh:ssh-1@@pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['ssh:ssh-1@@pty-agent'] },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'ssh:ssh-1@@pty-agent' }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'ssh:ssh-1@@pty-agent'
    })

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().lastKnownRelayPtyIdByTabId['tab-1']).toBeUndefined()
  })

  it('does not retain stale completion evidence when pane status changes during hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.pty.kill.mockImplementationOnce(async () => {
      store
        .getState()
        .setAgentStatus(
          targetPaneKey,
          { state: 'working', prompt: 'still running', agentType: 'codex' },
          'Codex',
          { updatedAt: 3000, stateStartedAt: 3000 },
          { tabId: 'tab-1', worktreeId: wt },
          { providerSession: { key: 'session_id', id: 'target-session' } }
        )
    })
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex', ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: targetLeaf },
          activeLeafId: targetLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [targetLeaf]: 'pty-agent' }
        }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-agent'] }
    })
    store.getState().setAgentStatus(
      targetPaneKey,
      {
        state: 'done',
        prompt: 'stale done',
        agentType: 'codex',
        lastAssistantMessage: 'old done'
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'target-session' } }
    )

    await store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
      paneKey: targetPaneKey,
      tabId: 'tab-1',
      leafId: targetLeaf,
      ptyId: 'pty-agent'
    })

    expect(store.getState().agentStatusByPaneKey[targetPaneKey]).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys[targetPaneKey]).toBe(true)
  })

  it('rolls back target suppressions when target-only runtime stop fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const targetLeaf = '11111111-1111-4111-8111-111111111111'
    const siblingLeaf = '22222222-2222-4222-8222-222222222222'
    const targetPaneKey = `tab-1:${targetLeaf}`

    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['terminal-1'],
                  livePtyIds: ['terminal-1', 'terminal-2'],
                  postStopVerified: false,
                  postStopFailure: 'target_still_live'
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: targetLeaf },
            second: { type: 'leaf', leafId: siblingLeaf }
          },
          activeLeafId: siblingLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [targetLeaf]: 'remote:env-1@@terminal-1',
            [siblingLeaf]: 'remote:env-1@@terminal-2'
          }
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:env-1@@terminal-1', 'remote:env-1@@terminal-2']
      }
    })
    store
      .getState()
      .setAgentStatus(
        targetPaneKey,
        { state: 'done', prompt: 'resume target', agentType: 'codex' },
        'Codex',
        { updatedAt: 2000, stateStartedAt: 1000 },
        { tabId: 'tab-1', worktreeId: wt },
        { providerSession: { key: 'session_id', id: 'target-session' } }
      )

    await expect(
      store.getState().shutdownCompletedAgentPaneForHibernation(wt, {
        paneKey: targetPaneKey,
        tabId: 'tab-1',
        leafId: targetLeaf,
        ptyId: 'remote:env-1@@terminal-1',
        expectedRuntimePtyId: 'terminal-1'
      })
    ).rejects.toThrow('target_still_live')

    const state = store.getState()
    expect(state.ptyIdsByTabId['tab-1']).toEqual([
      'remote:env-1@@terminal-1',
      'remote:env-1@@terminal-2'
    ])
    expect(state.suppressedPtyExitIds['remote:env-1@@terminal-1']).toBeUndefined()
    expect(state.suppressedPtyExitIds['terminal-1']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.agentStatusByPaneKey[targetPaneKey]).toBeDefined()
  })

  it('records terminal input even before agent sleep is enabled', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput('tab-1:leaf-1', 1000)

    expect(store.getState().lastTerminalInputAtByPaneKey['tab-1:leaf-1']).toBe(1000)
  })

  it('asks sleep-time buffer capture to skip local scrollback serialization', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const capture = vi.fn()

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    shutdownBufferCaptures.set('tab-1', capture)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false })
  })

  it('does not stop the active runtime when sleeping an SSH-owned worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'ssh:ssh-1@@pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['ssh:ssh-1@@pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(mockApi.pty.kill).toHaveBeenCalledWith('ssh:ssh-1@@pty-1', { keepHistory: true })
  })

  it('stops the owner runtime when sleeping a runtime-owned compatibility worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.stop'
      })
    )
  })

  it('stops the explicit owner runtime when another host is focused', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [
        {
          id: 'repo1',
          path: '/path/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-runtime',
        method: 'terminal.stop'
      })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'focused-runtime',
        method: 'terminal.stop'
      })
    )
  })

  it('commits sleep state after exact runtime stop for runtime-backed PTYs', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.stopExact',
        params: expect.objectContaining({ expectedPtyIds: ['pty-1'], keepHistory: true })
      })
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop post-check is inconclusive', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['pty-1'],
                  livePtyIds: ['pty-1'],
                  postStopVerified: false,
                  postStopFailure: 'terminal_liveness_unavailable'
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('terminal_liveness_unavailable')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop omits post-check proof', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'] }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('exact_terminal_stop_unverified')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('clears exact-stop exit suppression when a slept PTY ID wakes live again', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBe(true)

    store.getState().updateTabPtyId('tab-1', 'pty-1')

    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
  })

  it('suppresses wrapped remote PTY exits before exact runtime stop resolves', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let sawWrappedSuppressedDuringStop = false
    let sawRawSuppressedDuringStop = false
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.stopExact') {
        sawWrappedSuppressedDuringStop = store
          .getState()
          .consumeSuppressedPtyExit('remote:env-1@@terminal-1')
        sawRawSuppressedDuringStop = store.getState().consumeSuppressedPtyExit('terminal-1')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: {
            stoppedPtyIds: ['terminal-1'],
            livePtyIds: ['terminal-1'],
            postStopVerified: true
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['terminal-1']
    })

    expect(sawWrappedSuppressedDuringStop).toBe(true)
    expect(sawRawSuppressedDuringStop).toBe(true)
  })

  it('clears raw and wrapped remote exit suppression when a remote PTY wakes live again', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().suppressPtyExit('remote:env-1@@terminal-1')
    store.getState().suppressPtyExit('terminal-1')

    store.getState().updateTabPtyId('tab-1', 'remote:env-1@@terminal-1')

    expect(store.getState().suppressedPtyExitIds['remote:env-1@@terminal-1']).toBeUndefined()
    expect(store.getState().suppressedPtyExitIds['terminal-1']).toBeUndefined()
  })

  it('commits the pre-stop sleeping record when exact-stop exit clears live status', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().removeAgentStatus('tab-1:live')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
  })

  it('commits pre-stop retained evidence when exact-stop clears live status during hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().removeAgentStatus('tab-1:live')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex',
        lastAssistantMessage: 'done'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:live']).toMatchObject({
      worktreeId: wt,
      entry: {
        prompt: 'resume live',
        lastAssistantMessage: 'done',
        providerSession: { key: 'session_id', id: 'live-session' }
      }
    })
  })

  it('does not commit stale pre-stop evidence when exact-stop changes live status', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().setAgentStatus(
          'tab-1:live',
          {
            state: 'working',
            prompt: 'still active',
            agentType: 'codex'
          },
          'Codex',
          { updatedAt: 1500, stateStartedAt: 1500 },
          { tabId: 'tab-1', worktreeId: wt },
          { providerSession: { key: 'session_id', id: 'live-session' } }
        )
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'stale done',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:live']).toBe(true)
  })

  it('does not commit sleep state when exact runtime stop fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.stopExact') {
        return Promise.reject(new Error('stop failed'))
      }
      return Promise.resolve({
        id: 'rpc-default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('stop failed')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(mockUnregisterPtyDataHandlers).not.toHaveBeenCalledWith(['pty-1'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop returns the wrong set', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['pty-1'],
                  livePtyIds: ['pty-1', 'pty-shell'],
                  postStopVerified: true
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus('tab-1:live', {
      state: 'done',
      prompt: 'resume live',
      agentType: 'codex'
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('exact_terminal_stop_mismatch')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('drops live agentStatusByPaneKey entries on sleep so the working row disappears', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:0']).toBeDefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const s = store.getState()
    expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
  })

  it('captures resumable provider session metadata before dropping sleep-time rows', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus(
      'tab-1:0',
      {
        state: 'working',
        prompt: 'resume this',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:0']).toMatchObject({
      paneKey: 'tab-1:0',
      tabId: 'tab-1',
      worktreeId: wt,
      agent: 'codex',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'codex-session-1' },
      prompt: 'resume this',
      terminalTitle: 'Codex'
    })
  })

  it('skips allowlisted done live sleeping pane sessions during manual sleep', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:retained',
          state: 'done',
          stateStartedAt: 900,
          updatedAt: 900,
          prompt: 'old retained',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'old-session' },
          stateHistory: []
        },
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Old Codex' }),
        worktreeId: wt,
        agentType: 'codex',
        startedAt: 900
      }
    ])

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live']
    })

    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:retained']).toBeUndefined()
  })

  it('retains only clean slept completions during automatic hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const otherWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: otherWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })],
        [otherWt]: [makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] }
    })

    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'new retained prompt',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1800, stateStartedAt: 1800 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'new retained prompt',
        agentType: 'codex',
        lastAssistantMessage: 'new final message',
        interrupted: false
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 2000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:live',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'stale same-pane prompt',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'old-session' }
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Old Codex' }),
        agentType: 'codex',
        startedAt: 1000
      },
      {
        entry: {
          paneKey: 'tab-1:retained',
          state: 'done',
          stateStartedAt: 1500,
          updatedAt: 1500,
          stateHistory: [],
          prompt: 'unslept retained prompt',
          agentType: 'codex'
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1500
      },
      {
        entry: {
          paneKey: 'tab-2:retained',
          state: 'done',
          stateStartedAt: 1600,
          updatedAt: 1600,
          stateHistory: [],
          prompt: 'other retained prompt',
          agentType: 'codex'
        },
        worktreeId: otherWt,
        tab: makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1600
      }
    ])
    store.getState().acknowledgeAgents(['tab-1:live', 'tab-1:retained', 'tab-2:retained'])
    const liveAck = store.getState().acknowledgedAgentsByPaneKey['tab-1:live']
    store.getState().setMigrationUnsupportedPty({
      ptyId: 'pty-legacy',
      worktreeId: wt,
      paneKey: 'tab-1:legacy',
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1700
    })

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live']
    })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:live']).toMatchObject({
      worktreeId: wt,
      startedAt: 1800,
      entry: {
        prompt: 'new retained prompt',
        lastAssistantMessage: 'new final message',
        providerSession: { key: 'session_id', id: 'live-session' }
      }
    })
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      paneKey: 'tab-1:live',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(state.retainedAgentsByPaneKey['tab-1:retained']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-2:retained']).toBeDefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:live']).toBe(liveAck)
    expect(state.acknowledgedAgentsByPaneKey['tab-1:retained']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-2:retained']).toBeGreaterThan(0)
    expect(state.migrationUnsupportedByPtyId['pty-legacy']).toBeUndefined()
    expect(state.retentionSuppressedPaneKeys['tab-1:live']).toBeUndefined()
  })

  it('does not retain interrupted, non-done, or retained-only rows on automatic hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:interrupted', {
      state: 'done',
      prompt: 'cancelled',
      agentType: 'codex',
      interrupted: true
    })
    store.getState().setAgentStatus('tab-1:working', {
      state: 'working',
      prompt: 'still working',
      agentType: 'codex'
    })
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:retained-only',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'retained only',
          agentType: 'codex'
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1000
      }
    ])
    store
      .getState()
      .acknowledgeAgents(['tab-1:interrupted', 'tab-1:working', 'tab-1:retained-only'])

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:interrupted', 'tab-1:working', 'tab-1:retained-only']
    })

    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.retentionSuppressedPaneKeys['tab-1:interrupted']).toBe(true)
    expect(state.retentionSuppressedPaneKeys['tab-1:working']).toBe(true)
  })

  it('does not preserve provider session metadata when a pane switches agent type', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus(
      'tab-1:0',
      {
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        interrupted: false
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    store.getState().setAgentStatus(
      'tab-1:0',
      {
        state: 'working',
        prompt: 'claude prompt',
        agentType: 'claude'
      },
      'Claude',
      { updatedAt: 2000, stateStartedAt: 2000 },
      { tabId: 'tab-1', worktreeId: wt }
    )

    const liveEntry = store.getState().agentStatusByPaneKey['tab-1:0']
    expect(liveEntry?.agentType).toBe('claude')
    expect(liveEntry?.providerSession).toBeUndefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:0']).toBeUndefined()
  })

  it('drops retainedAgentsByPaneKey entries for the slept worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const otherWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: otherWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })],
        [otherWt]: [makeTab({ id: 'tab-2', worktreeId: otherWt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    // Plant one current-tab row and one orphan row. Retained rows render by
    // worktreeId, so sleep must sweep both instead of only tab prefixes.
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:0',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'finished prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1000
      },
      {
        entry: {
          paneKey: 'tab-orphan:0',
          state: 'done',
          stateStartedAt: 1001,
          updatedAt: 1001,
          stateHistory: [],
          prompt: 'orphaned finished prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-orphan', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1001
      },
      {
        entry: {
          paneKey: 'tab-2:0',
          state: 'done',
          stateStartedAt: 1002,
          updatedAt: 1002,
          stateHistory: [],
          prompt: 'other prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: otherWt,
        tab: makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1002
      }
    ])
    expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeDefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-orphan:0']).toBeDefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-2:0']).toBeDefined()
    store.getState().acknowledgeAgents(['tab-1:0', 'tab-orphan:0', 'tab-2:0'])

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-orphan:0']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-2:0']).toBeDefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-orphan:0']).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-2:0']).toBeGreaterThan(0)
  })

  it('clears prior acknowledgements on sleep because the worktree surface is folded', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    store.getState().acknowledgeAgents(['tab-1:0'])
    const ackBeforeSleep = store.getState().acknowledgedAgentsByPaneKey['tab-1:0']
    expect(ackBeforeSleep).toBeGreaterThan(0)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
  })

  it('plants retention suppressors on sleep so a previously-live `done` cannot re-retain', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'done',
      prompt: 'p',
      agentType: 'claude'
    })
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBeUndefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    // Why: sleep folds retained rows too, so the next retention sync must not
    // recreate a `done` row from the previous render after the user slept it.
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
  })

  it('preserves existing retention suppressors across sleep (identity-preserved suppressor map)', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      retentionSuppressedPaneKeys: { 'tab-1:0': true }
    })

    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    // Why: an existing suppressor was planted by a prior dismissal flow; sleep
    // must not erase it (would resurface a row the user already dismissed).
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
  })

  it('still wipes retained + ack entries under remove-worktree shutdown', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    store.getState().acknowledgeAgents(['tab-1:0'])
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:0',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'p',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1000
      }
    ])

    // Default opts (no keepIdentifiers) => remove-worktree path.
    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(s.retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(s.acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
  })
})

// Why: CLI-spawned background terminals stamp ORCA_PANE_KEY into the PTY env
// at spawn time. The renderer must adopt the tab under the same id so hook
// events route to the correct slot.
describe('createTab tabId hint', () => {
  it('uses the supplied id when no collision exists', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const hintedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const tab = store.getState().createTab(wt, undefined, undefined, { id: hintedId })

    expect(tab.id).toBe(hintedId)
  })

  it('falls back to a fresh id on collision and warns', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-collision'
    const existingId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-collision' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: existingId, worktreeId: wt })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: existingId })
      expect(tab.id).not.toBe(existingId)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(existingId))
    } finally {
      warn.mockRestore()
    }
  })

  it('treats tab ids as global and rejects hints that collide in another worktree', () => {
    const store = createTestStore()
    const wtA = 'repo1::/path/wt-a'
    const wtB = 'repo1::/path/wt-b'
    const existingId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wtA, repoId: 'repo1', path: '/path/wt-a' }),
          makeWorktree({ id: wtB, repoId: 'repo1', path: '/path/wt-b' })
        ]
      },
      tabsByWorktree: {
        [wtB]: [makeTab({ id: existingId, worktreeId: wtB })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wtA, undefined, undefined, { id: existingId })
      expect(tab.id).not.toBe(existingId)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(existingId))
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores empty string hints instead of persisting an unusable tab id', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-empty-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-empty-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: '' })
      expect(tab.id).not.toBe('')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores web mirror id hints instead of making them canonical host tab ids', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-web-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-web-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const hintedId = 'web-terminal-host-tab-1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: hintedId })
      expect(tab.id).not.toBe(hintedId)
      expect(tab.id).not.toMatch(/^web-terminal-/)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
