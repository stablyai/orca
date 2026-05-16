import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { AppState } from '../types'
import type { WorktreeLineage } from '../../../../shared/types'
import { toast } from 'sonner'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const runtimeEnvironmentCall = vi.fn()
const settingsSet = vi.fn().mockResolvedValue(undefined)

const env2Lineage: WorktreeLineage = {
  worktreeId: 'repo-env-2::/env-2/repo',
  worktreeInstanceId: 'env-2-instance',
  parentWorktreeId: 'repo-env-2::/env-2/parent',
  parentWorktreeInstanceId: 'env-2-parent-instance',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'runtime-2',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          }
        : method === 'repo.list'
          ? {
              repos: [
                {
                  id: 'repo-env-2',
                  path: '/env-2/repo',
                  displayName: 'Env 2',
                  badgeColor: 'blue',
                  addedAt: 1
                }
              ]
            }
          : method === 'worktree.list'
            ? {
                worktrees: [
                  makeWorktree({
                    id: 'repo-env-2::/env-2/repo',
                    repoId: 'repo-env-2',
                    path: '/env-2/repo'
                  })
                ],
                totalCount: 1,
                truncated: false
              }
            : method === 'browser.profile.list'
              ? { profiles: [] }
              : method === 'worktree.lineageList'
                ? { lineage: { [env2Lineage.worktreeId]: env2Lineage } }
                : {}
    return Promise.resolve({ id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-2' } })
  })
  vi.stubGlobal('window', {
    api: {
      settings: { set: settingsSet },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

describe('createSettingsSlice runtime switching', () => {
  it('clears stale runtime-owned state before loading the selected environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-env-1', path: '/env-1/repo', displayName: 'Env 1' } as never],
      worktreesByRepo: {
        'repo-env-1': [makeWorktree({ id: 'repo-env-1::/env-1/repo', repoId: 'repo-env-1' })]
      },
      worktreeLineageById: {
        'repo-env-1::/env-1/repo': {
          ...env2Lineage,
          worktreeId: 'repo-env-1::/env-1/repo',
          parentWorktreeId: 'repo-env-1::/env-1/parent'
        }
      },
      activeWorktreeId: 'repo-env-1::/env-1/repo',
      openFiles: [{ id: '/env-1/repo/a.md', worktreeId: 'repo-env-1::/env-1/repo' } as never],
      ptyIdsByTabId: { tab1: ['remote:env-1@@terminal-a'] },
      terminalLayoutsByTabId: {
        tab1: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'remote:legacy-terminal' }
        }
      },
      browserTabsByWorktree: { 'repo-env-1::/env-1/repo': [{ id: 'browser-env-1' }] as never },
      browserPagesByWorkspace: {
        'browser-env-1': [{ id: 'page-env-1', worktreeId: 'repo-env-1::/env-1/repo' }] as never
      },
      remoteBrowserPageHandlesByPageId: {
        'page-env-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      },
      editorDrafts: { '/env-1/repo/stale.md': 'stale' },
      markdownViewMode: { '/env-1/repo/stale.md': 'rich' },
      editorViewMode: { '/env-1/repo/stale.md': 'changes' },
      editorCursorLine: { '/env-1/repo/stale.md': 4 },
      prCache: { '/env-1/repo::main': { data: null, fetchedAt: Date.now() } },
      linearIssueCache: { 'LIN-1': { data: { id: 'LIN-1' } as never, fetchedAt: Date.now() } }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(true)

    expect(settingsSet).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-2' })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'status.get' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'repo.list' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'worktree.lineageList' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.close',
        params: { terminal: 'terminal-a' }
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.close',
        params: { terminal: 'legacy-terminal' }
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:repo-env-1::/env-1/repo', page: 'remote-page-1' }
      })
    )
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['repo-env-2'])
    expect(store.getState().worktreesByRepo['repo-env-2']?.map((worktree) => worktree.id)).toEqual([
      'repo-env-2::/env-2/repo'
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      [env2Lineage.worktreeId]: env2Lineage
    })
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().editorDrafts).toEqual({})
    expect(store.getState().markdownViewMode).toEqual({})
    expect(store.getState().editorViewMode).toEqual({})
    expect(store.getState().editorCursorLine).toEqual({})
    expect(store.getState().ptyIdsByTabId).toEqual({})
    expect(store.getState().browserTabsByWorktree).toEqual({})
    expect(store.getState().prCache).toEqual({})
    expect(store.getState().linearIssueCache).toEqual({})
  })

  it('refuses to switch environments while editor tabs have unsaved state', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      openFiles: [
        {
          id: '/env-1/repo/dirty.md',
          worktreeId: 'repo-env-1::/env-1/repo',
          isDirty: true
        } as never
      ],
      editorDrafts: { '/env-1/repo/dirty.md': 'draft' }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(false)

    expect(settingsSet).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().settings?.activeRuntimeEnvironmentId).toBe('env-1')
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().editorDrafts).toEqual({ '/env-1/repo/dirty.md': 'draft' })
    expect(toast.error).toHaveBeenCalledWith(
      'Save or close unsaved editor tabs before switching servers.'
    )
  })

  it('keeps the current environment when the selected remote server is unreachable', async () => {
    runtimeEnvironmentCall.mockRejectedValueOnce(
      new Error('Remote Orca runtime closed the connection.')
    )
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-env-1', path: '/env-1/repo', displayName: 'Env 1' } as never],
      openFiles: [],
      ptyIdsByTabId: { tab1: ['remote:env-1@@terminal-a'] }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(false)

    expect(settingsSet).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'status.get' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'terminal.close' })
    )
    expect(store.getState().settings?.activeRuntimeEnvironmentId).toBe('env-1')
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['repo-env-1'])
    expect(store.getState().ptyIdsByTabId).toEqual({ tab1: ['remote:env-1@@terminal-a'] })
    expect(toast.error).toHaveBeenCalledWith('Failed to switch servers', {
      description: 'Remote Orca runtime closed the connection.'
    })
  })

  it('keeps the current environment when the selected server is protocol-incompatible', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'runtime-old',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1,
              minCompatibleRuntimeClientVersion: 0
            }
          : {}
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-old' }
      })
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-env-1', path: '/env-1/repo', displayName: 'Env 1' } as never],
      openFiles: []
    })

    await expect(store.getState().switchRuntimeEnvironment('env-old')).resolves.toBe(false)

    expect(settingsSet).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-old', method: 'status.get' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-old', method: 'repo.list' })
    )
    expect(toast.error).toHaveBeenCalledWith('Failed to switch servers', {
      description: expect.stringContaining('server is too old')
    })
  })
})
