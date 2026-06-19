import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { AppState } from '../types'
import type { WorktreeLineage } from '../../../../shared/types'
import { toast } from 'sonner'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
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
const runtimeEnvironmentGetStatus = vi.fn()
const settingsSet = vi.fn().mockResolvedValue(undefined)
const worktreesListDetected = vi.fn()

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
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentGetStatus.mockResolvedValue({
    id: 'status-rpc-1',
    ok: true,
    result: {
      runtimeId: 'runtime-2',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId: 'runtime-2' }
  })
  runtimeEnvironmentCall.mockImplementation(
    ({ method, params }: { method: string; params?: { repo?: string } }) => {
      const detectedRepoId = params?.repo ?? 'repo-env-2'
      const detectedPath = detectedRepoId === 'repo-env-1' ? '/env-1/repo' : '/env-2/repo'
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
              : method === 'worktree.detectedList'
                ? {
                    repoId: detectedRepoId,
                    authoritative: true,
                    source: 'git',
                    worktrees: [
                      {
                        ...makeWorktree({
                          id: `${detectedRepoId}::${detectedPath}`,
                          repoId: detectedRepoId,
                          path: detectedPath
                        }),
                        ownership: 'orca-managed',
                        selectedCheckout: true,
                        visible: true
                      }
                    ]
                  }
                : method === 'browser.profileList'
                  ? { profiles: [] }
                  : method === 'projectGroup.list'
                    ? { groups: [] }
                    : method === 'worktree.lineageList'
                      ? { lineage: { [env2Lineage.worktreeId]: env2Lineage } }
                      : {}
      return Promise.resolve({ id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-2' } })
    }
  )
  worktreesListDetected.mockResolvedValue({
    repoId: 'repo-env-1',
    authoritative: true,
    source: 'git',
    worktrees: [
      {
        ...makeWorktree({
          id: 'repo-env-1::/env-1/repo',
          repoId: 'repo-env-1',
          path: '/env-1/repo'
        }),
        ownership: 'orca-managed',
        selectedCheckout: true,
        visible: true
      }
    ]
  })
  vi.stubGlobal('window', {
    api: {
      settings: { set: settingsSet },
      runtimeEnvironments: { call: runtimeEnvironmentCall, getStatus: runtimeEnvironmentGetStatus },
      worktrees: { listDetected: worktreesListDetected }
    }
  })
})

describe('createSettingsSlice runtime switching', () => {
  it('repairs drifted task provider settings before sending updates', async () => {
    settingsSet.mockResolvedValueOnce({
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskSource: 'github'
    })
    const store = createTestStore()
    store.setState({
      settings: {
        visibleTaskProviders: ['linear'],
        defaultTaskSource: 'github'
      } as AppState['settings']
    })

    await store.getState().updateSettings({
      visibleTaskProviders: ['linear']
    })

    expect(settingsSet).toHaveBeenCalledWith({
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskSource: 'github'
    })
  })

  it('rebases local state to the authoritative settings:set response', async () => {
    settingsSet.mockResolvedValueOnce({
      openInApplications: [{ id: 'cursor', label: 'Cursor', command: 'cursor' }],
      notifications: {}
    })
    const store = createTestStore()
    store.setState({
      settings: {
        openInApplications: [],
        notifications: {}
      } as unknown as AppState['settings']
    })

    await store.getState().updateSettings({
      openInApplications: [{ id: '  ', label: ' Cursor ', command: ' cursor ' }] as never
    })

    expect(store.getState().settings?.openInApplications).toEqual([
      { id: 'cursor', label: 'Cursor', command: 'cursor' }
    ])
  })

  it('preserves existing host state while loading the selected environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: 'repo-env-1',
          path: '/env-1/repo',
          displayName: 'Env 1',
          executionHostId: 'runtime:env-1'
        } as never
      ],
      projectGroups: [
        {
          id: 'group-env-1',
          name: 'Env 1 Group',
          parentPath: '/env-1',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
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
      markdownFrontmatterVisible: { '/env-1/repo/stale.md': true },
      editorCursorLine: { '/env-1/repo/stale.md': 4 },
      showDotfilesByWorktree: { 'repo-env-1::/env-1/repo': false },
      gitIgnoredPathsByWorktree: { 'repo-env-1::/env-1/repo': ['dist/'] },
      prCache: { '/env-1/repo::main': { data: null, fetchedAt: Date.now() } },
      linearIssueCache: { 'LIN-1': { data: { id: 'LIN-1' } as never, fetchedAt: Date.now() } },
      jiraIssueCache: { 'JIRA-1': { data: { key: 'JIRA-1' } as never, fetchedAt: Date.now() } }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(true)

    expect(settingsSet).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-2' })
    expect(runtimeEnvironmentGetStatus).toHaveBeenCalledWith({
      selector: 'env-2',
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'status.get' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'repo.list' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'worktree.lineageList' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'terminal.close' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'browser.tabClose' })
    )
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['repo-env-1', 'repo-env-2'])
    expect(store.getState().repos.find((repo) => repo.id === 'repo-env-2')?.executionHostId).toBe(
      'runtime:env-2'
    )
    expect(store.getState().projectGroups.map((group) => group.id)).toEqual(['group-env-1'])
    expect(store.getState().worktreesByRepo['repo-env-1']?.map((worktree) => worktree.id)).toEqual([
      'repo-env-1::/env-1/repo'
    ])
    expect(store.getState().worktreesByRepo['repo-env-2']?.map((worktree) => worktree.id)).toEqual([
      'repo-env-2::/env-2/repo'
    ])
    expect(store.getState().worktreeLineageById).toEqual({
      'repo-env-1::/env-1/repo': {
        ...env2Lineage,
        worktreeId: 'repo-env-1::/env-1/repo',
        parentWorktreeId: 'repo-env-1::/env-1/parent'
      },
      [env2Lineage.worktreeId]: env2Lineage
    })
    expect(store.getState().activeWorktreeId).toBe('repo-env-1::/env-1/repo')
    expect(store.getState().openFiles).toEqual([
      { id: '/env-1/repo/a.md', worktreeId: 'repo-env-1::/env-1/repo' }
    ])
    expect(store.getState().editorDrafts).toEqual({ '/env-1/repo/stale.md': 'stale' })
    expect(store.getState().markdownViewMode).toEqual({ '/env-1/repo/stale.md': 'rich' })
    expect(store.getState().editorViewMode).toEqual({ '/env-1/repo/stale.md': 'changes' })
    expect(store.getState().markdownFrontmatterVisible).toEqual({
      '/env-1/repo/stale.md': true
    })
    expect(store.getState().editorCursorLine).toEqual({ '/env-1/repo/stale.md': 4 })
    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-env-1::/env-1/repo': false })
    expect(store.getState().gitIgnoredPathsByWorktree).toEqual({
      'repo-env-1::/env-1/repo': ['dist/']
    })
    expect(store.getState().ptyIdsByTabId).toEqual({ tab1: ['remote:env-1@@terminal-a'] })
    expect(store.getState().browserTabsByWorktree).toEqual({
      'repo-env-1::/env-1/repo': [{ id: 'browser-env-1' }]
    })
    expect(store.getState().prCache).toEqual({
      '/env-1/repo::main': expect.objectContaining({ data: null })
    })
    expect(store.getState().linearIssueCache).toEqual({
      'LIN-1': expect.objectContaining({ data: { id: 'LIN-1' } })
    })
    expect(store.getState().jiraIssueCache).toEqual({
      'JIRA-1': expect.objectContaining({ data: { key: 'JIRA-1' } })
    })
  })

  it('does not close host-owned mirrored resources when a paired web client switches servers', async () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: 'repo-env-1',
          path: '/env-1/repo',
          displayName: 'Env 1',
          executionHostId: 'runtime:env-1'
        } as never
      ],
      worktreesByRepo: {
        'repo-env-1': [makeWorktree({ id: 'repo-env-1::/env-1/repo', repoId: 'repo-env-1' })]
      },
      activeWorktreeId: 'repo-env-1::/env-1/repo',
      tabsByWorktree: {
        'repo-env-1::/env-1/repo': [
          {
            id: 'web-terminal-host-tab-1',
            ptyId: 'remote:env-1@@terminal-a',
            worktreeId: 'repo-env-1::/env-1/repo',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'web-terminal-host-tab-1': ['remote:env-1@@terminal-a'] },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab-1': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'remote:env-1@@terminal-a' }
        }
      },
      browserTabsByWorktree: { 'repo-env-1::/env-1/repo': [{ id: 'browser-env-1' }] as never },
      browserPagesByWorkspace: {
        'browser-env-1': [{ id: 'page-env-1', worktreeId: 'repo-env-1::/env-1/repo' }] as never
      },
      remoteBrowserPageHandlesByPageId: {
        'page-env-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(true)

    expect(settingsSet).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-2' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'terminal.close' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'browser.tabClose' })
    )
    expect(store.getState().ptyIdsByTabId).toEqual({
      'web-terminal-host-tab-1': ['remote:env-1@@terminal-a']
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({
      'page-env-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
    })
  })

  it('keeps the previous host live terminal and browser resources intact on switch (multi-host keepalive)', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: 'repo-env-1',
          path: '/env-1/repo',
          displayName: 'Env 1',
          executionHostId: 'runtime:env-1'
        } as never
      ],
      worktreesByRepo: {
        'repo-env-1': [makeWorktree({ id: 'repo-env-1::/env-1/repo', repoId: 'repo-env-1' })]
      },
      activeWorktreeId: 'repo-env-1::/env-1/repo',
      tabsByWorktree: {
        'repo-env-1::/env-1/repo': [
          {
            id: 'host-tab-1',
            ptyId: 'remote:env-1@@terminal-a',
            worktreeId: 'repo-env-1::/env-1/repo',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'host-tab-1': ['remote:env-1@@terminal-a'] },
      terminalLayoutsByTabId: {
        'host-tab-1': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'remote:env-1@@terminal-a' }
        }
      },
      browserPagesByWorkspace: {
        'browser-env-1': [{ id: 'page-env-1', worktreeId: 'repo-env-1::/env-1/repo' }] as never
      },
      remoteBrowserPageHandlesByPageId: {
        'page-env-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(true)

    // No teardown RPC was issued against the previous host's live resources.
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'terminal.close' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'browser.tabClose' })
    )

    // Every previous-host map is byte-for-byte unchanged after the switch.
    expect(store.getState().tabsByWorktree).toEqual({
      'repo-env-1::/env-1/repo': [
        {
          id: 'host-tab-1',
          ptyId: 'remote:env-1@@terminal-a',
          worktreeId: 'repo-env-1::/env-1/repo',
          title: 'Terminal 1',
          defaultTitle: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    })
    expect(store.getState().ptyIdsByTabId).toEqual({
      'host-tab-1': ['remote:env-1@@terminal-a']
    })
    expect(store.getState().terminalLayoutsByTabId).toEqual({
      'host-tab-1': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { 'pane:1': 'remote:env-1@@terminal-a' }
      }
    })
    expect(store.getState().browserPagesByWorkspace).toEqual({
      'browser-env-1': [{ id: 'page-env-1', worktreeId: 'repo-env-1::/env-1/repo' }]
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({
      'page-env-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
    })
  })

  it('allows switching focus while editor tabs have unsaved state', async () => {
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

    await expect(store.getState().switchRuntimeEnvironment('env-2')).resolves.toBe(true)

    expect(settingsSet).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: 'env-2' })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'repo.list' })
    )
    expect(store.getState().settings?.activeRuntimeEnvironmentId).toBe('env-2')
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().editorDrafts).toEqual({ '/env-1/repo/dirty.md': 'draft' })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps the current environment when the selected remote server is unreachable', async () => {
    runtimeEnvironmentGetStatus.mockRejectedValueOnce(
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
    expect(runtimeEnvironmentGetStatus).toHaveBeenCalledWith({
      selector: 'env-2',
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
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
    runtimeEnvironmentGetStatus.mockResolvedValueOnce({
      id: 'status-rpc-old',
      ok: true,
      result: {
        runtimeId: 'runtime-old',
        graphStatus: 'ready',
        runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
        minCompatibleRuntimeClientVersion: 0
      },
      _meta: { runtimeId: 'runtime-old' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-env-1', path: '/env-1/repo', displayName: 'Env 1' } as never],
      openFiles: []
    })

    await expect(store.getState().switchRuntimeEnvironment('env-old')).resolves.toBe(false)

    expect(settingsSet).not.toHaveBeenCalled()
    expect(runtimeEnvironmentGetStatus).toHaveBeenCalledWith({
      selector: 'env-old',
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Failed to switch servers', {
      description: expect.stringContaining('server is too old')
    })
  })
})
