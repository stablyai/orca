import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { WORKTREE_REFRESH_CONCURRENCY } from './worktrees'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import { purgeHydratedWorktrees } from './worktrees/listing/hydrated-worktree-purge'
import { worktreeCatalogVersionKey } from './worktrees/listing/worktree-catalog-version-state'
import { makeTab } from './store-session-test-harness'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  worktreeListMock
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why: design §4.4 — hydration purge gated on per-repo success (F1 regression) so a git error can't wipe tabsByWorktree.
describe('fetchAllWorktrees hydration-time purge (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  const repoA = {
    id: 'repoA',
    path: '/repos/a',
    displayName: 'a',
    badgeColor: '#000',
    addedAt: 0
  }
  const repoB = {
    id: 'repoB',
    path: '/repos/b',
    displayName: 'b',
    badgeColor: '#111',
    addedAt: 0
  }

  it.each(['unchanged', 'newer catalog', 'new owner', 'unloaded runtime'])(
    'reuses startup scan evidence after session restoration: %s',
    async (change) => {
      const store = createTestStore()
      const live = makeWorktree({ id: 'repoA::/a/live', repoId: 'repoA', path: '/a/live' })
      mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
        qualifyDetectedResult(
          args,
          makeDetectedResult(repoA.id, [live], {
            catalogVersion: { epoch: 'startup', sequence: 1 }
          })
        )
      )
      store.setState({
        repos: [repoA],
        hydrationSucceeded: false,
        workspaceSessionReady: false
      })
      const results = await store.getState().fetchAllWorktrees({
        visibilityOwnerHostId: 'local',
        hydrationPurge: 'defer'
      })
      expect(store.getState().hasHydratedWorktreePurge).toBe(false)
      store.setState({
        hydrationSucceeded: true,
        workspaceSessionReady: true,
        tabsByWorktree: {
          'repoA::/a/stale': [makeTab({ id: 'saved', worktreeId: 'repoA::/a/stale' })]
        }
      })
      if (change === 'newer catalog') {
        store.setState({
          worktreeCatalogVersionByRepoHost: {
            [worktreeCatalogVersionKey(repoA.id, 'local')]: { epoch: 'startup', sequence: 2 }
          }
        })
      } else if (change === 'new owner') {
        store.setState({ repos: [repoA, repoB] })
      } else if (change === 'unloaded runtime') {
        store.setState({
          restoredRuntimeHostIdByWorkspaceSessionKey: {
            'remote-repo::/remote/saved': 'runtime:offline'
          }
        })
      }
      purgeHydratedWorktrees(store.setState, store.getState, results)
      expect(store.getState().hasHydratedWorktreePurge).toBe(change === 'unchanged')
      expect(store.getState().tabsByWorktree['repoA::/a/stale'] === undefined).toBe(
        change === 'unchanged'
      )
      expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    }
  )

  // D1b-7a: hydration keeps only a moved project's chats, which stay on this computer.
  it("keeps a moved project's chats through the purge, and still purges a stale worktree", async () => {
    const store = createTestStore()
    const live = makeWorktree({ id: 'repoA::/a/live', repoId: 'repoA', path: '/a/live' })
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult(repoA.id, [live]))
    )
    store.setState({ repos: [repoA], hydrationSucceeded: false, workspaceSessionReady: false })
    const results = await store.getState().fetchAllWorktrees({
      visibilityOwnerHostId: 'local',
      hydrationPurge: 'defer'
    })
    const moved = 'moved-repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
    const chat: Tab = {
      id: 'chat',
      entityId: 'agent-session-1',
      groupId: 'group-1',
      worktreeId: moved,
      contentType: 'agent-session',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    store.setState({
      hydrationSucceeded: true,
      workspaceSessionReady: true,
      wslMovedProjects: [
        {
          kind: 'repo',
          id: 'moved-repo',
          displayName: 'app',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app',
          distro: 'Ubuntu'
        }
      ],
      tabsByWorktree: {
        'repoA::/a/stale': [makeTab({ id: 'saved', worktreeId: 'repoA::/a/stale' })],
        [moved]: []
      },
      unifiedTabsByWorktree: { [moved]: [chat] }
    })
    purgeHydratedWorktrees(store.setState, store.getState, results)
    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree['repoA::/a/stale']).toBeUndefined()
    expect(store.getState().tabsByWorktree[moved]).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[moved]).toEqual([chat])
  })

  it('defers the purge when a sibling repo fetch fails (F1 regression)', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    // repoA succeeds, repoB throws; a stale tabsByWorktree entry must NOT be purged while any repo fetch is degraded.
    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      throw new Error('git error')
    })

    store.setState({
      repos: [repoA, repoB],
      worktreesByRepo: { repoB: [wtB] },
      tabsByWorktree: {
        'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })

    // After repoB recovers, the deferred purge fires for genuinely stale ids.
    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      return [wtB]
    })

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
  })

  it('defers the purge when every repo succeeds but none returns worktrees (empty-sibling safety)', async () => {
    const store = createTestStore()

    // Empty valid-id union (both repos newly-cloned, empty) isn't authoritative — defer instead of wiping tabsByWorktree.
    worktreeListMock.mockResolvedValue([])

    store.setState({
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
    })
  })

  it('fires the purge once when every repo returns successfully with ≥1 worktree', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-keep' })
    const folderKey = folderWorkspaceKey(folderWorkspace.id)

    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      repos: [repoA, repoB],
      folderWorkspaces: [folderWorkspace],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
        'repoA::/a/zombie': [{ id: 'tab-zombie', worktreeId: 'repoA::/a/zombie' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }],
        [folderKey]: [{ id: 'tab-folder', worktreeId: folderKey }]
      },
      gitIgnoredPathsByWorktree: {
        'repoA::/a/wt1': ['dist/'],
        'repoA::/a/zombie': ['coverage/'],
        'repoB::/b/wt1': ['build/'],
        [folderKey]: ['tmp/']
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(worktreeListMock).toHaveBeenCalledTimes(2)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }],
      [folderKey]: [{ id: 'tab-folder', worktreeId: folderKey }]
    })
    expect(store.getState().gitIgnoredPathsByWorktree).toEqual({
      'repoA::/a/wt1': ['dist/'],
      'repoB::/b/wt1': ['build/'],
      [folderKey]: ['tmp/']
    })

    // Second call must not re-run the purge even if new stale ids appear.
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        'repoA::/a/new-zombie': [{ id: 'tab-new-zombie', worktreeId: 'repoA::/a/new-zombie' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(worktreeListMock).toHaveBeenCalledTimes(4)
    expect(store.getState().tabsByWorktree['repoA::/a/new-zombie']).toBeDefined()
  })

  it('does not consume the one-shot purge before clean workspace session hydration', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      workspaceSessionReady: false,
      hydrationSucceeded: false,
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
        'repoA::/a/zombie': [{ id: 'tab-zombie', worktreeId: 'repoA::/a/zombie' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree['repoA::/a/zombie']).toBeDefined()

    store.setState({ workspaceSessionReady: true } as Partial<AppState>)
    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree['repoA::/a/zombie']).toBeDefined()

    store.setState({ hydrationSucceeded: true } as Partial<AppState>)
    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
  })

  it('preserves sibling host worktrees during hydrated refresh when repo ids are duplicated', async () => {
    const store = createTestStore()
    const localRepo = {
      id: 'same-repo',
      path: '/repos/local',
      displayName: 'same local',
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: 'local'
    }
    const runtimeRepo = {
      id: 'same-repo',
      path: '/repos/remote',
      displayName: 'same remote',
      badgeColor: '#111',
      addedAt: 1,
      executionHostId: 'runtime:env-1'
    }
    const localWorktree = makeWorktree({
      id: 'same-repo::/local/wt',
      repoId: 'same-repo',
      path: '/local/wt'
    })
    const staleRemoteWorktree = makeWorktree({
      id: 'same-repo::/remote/stale',
      repoId: 'same-repo',
      path: '/remote/stale',
      hostId: 'runtime:env-1'
    })
    const refreshedRemoteWorktree = makeWorktree({
      id: 'same-repo::/remote/fresh',
      repoId: 'same-repo',
      path: '/remote/fresh',
      hostId: 'local'
    })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('same-repo', [localWorktree])
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-duplicate-worktrees',
      ok: true,
      result: makeDetectedResult('same-repo', [refreshedRemoteWorktree]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    store.setState({
      hasHydratedWorktreePurge: true,
      repos: [localRepo, runtimeRepo],
      worktreesByRepo: {
        'same-repo': [localWorktree, staleRemoteWorktree]
      },
      detectedWorktreesByRepo: {
        'same-repo': makeDetectedResult('same-repo', [localWorktree, staleRemoteWorktree])
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    const refreshed = store.getState().worktreesByRepo['same-repo'] ?? []
    expect(refreshed).toHaveLength(2)
    expect(refreshed).toEqual(
      expect.arrayContaining([
        localWorktree,
        {
          ...refreshedRemoteWorktree,
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        }
      ])
    )
    expect(refreshed.map((worktree) => worktree.id)).not.toContain(staleRemoteWorktree.id)
    expect(store.getState().detectedWorktreesByRepo['same-repo']?.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: localWorktree.id }),
        expect.objectContaining({ id: refreshedRemoteWorktree.id, hostId: 'runtime:env-1' })
      ])
    )
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'same-repo',
        executionHostId: 'local'
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.detectedList',
      params: { repo: 'same-repo' },
      timeoutMs: 15_000
    })
  })

  it('reuses an offline runtime preflight across hydrated all-worktree refresh repos', async () => {
    const store = createTestStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repos = Array.from({ length: WORKTREE_REFRESH_CONCURRENCY + 2 }, (_, index) => ({
      id: `runtime-repo-${index}`,
      path: `/remote/repos/${index}`,
      displayName: `runtime-repo-${index}`,
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: 'runtime:env-offline'
    }))

    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: false,
          error: { code: 'runtime_unavailable', message: 'offline' },
          _meta: { runtimeId: 'runtime-offline' }
        })
      }
      return runtimeEnvironmentCall(args)
    })

    try {
      store.setState({
        hasHydratedWorktreePurge: true,
        repos
      } as unknown as Partial<AppState>)

      await store.getState().fetchAllWorktrees()
    } finally {
      consoleError.mockRestore()
    }

    expect(runtimeEnvironmentTransportCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get'
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
  })

  it('preserves floating workspace state while purging a real stale worktree', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })
    const staleId = 'repoA::/a/zombie'
    const floatingFile = {
      id: 'floating-file',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      filePath: '/floating/note.md',
      relativePath: 'note.md',
      language: 'markdown',
      isDirty: false,
      isPreview: false,
      mode: 'edit' as const
    }

    worktreeListMock.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      repos: [repoA, repoB],
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeFileId: 'floating-file',
      activeTabId: 'floating-terminal-tab',
      activeTabType: 'editor' as const,
      tabsByWorktree: {
        [wtA.id]: [{ id: 'tab-A', worktreeId: wtA.id }],
        [staleId]: [{ id: 'tab-zombie', worktreeId: staleId }],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
        ]
      },
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-browser', url: 'https://orca.test' }]
      },
      activeBrowserTabIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-browser'
      },
      openFiles: [
        floatingFile,
        {
          id: 'stale-file',
          worktreeId: staleId,
          filePath: '/a/zombie/stale.ts',
          relativePath: 'stale.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-file',
        [staleId]: 'stale-file'
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-unified-tab',
            type: 'editor',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            fileId: 'floating-file'
          }
        ],
        [staleId]: [{ id: 'stale-unified-tab', worktreeId: staleId }]
      },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: 'floating-unified-tab'
          }
        ],
        [staleId]: [{ id: 'stale-group', worktreeId: staleId, activeTabId: 'stale-unified-tab' }]
      },
      layoutByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: { type: 'leaf', groupId: 'floating-group' },
        [staleId]: { type: 'leaf', groupId: 'stale-group' }
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      [wtA.id]: [{ id: 'tab-A', worktreeId: wtA.id }],
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        { id: 'floating-terminal-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      ]
    })
    expect(store.getState().browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      { id: 'floating-browser', url: 'https://orca.test' }
    ])
    expect(store.getState().openFiles).toEqual([floatingFile])
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'floating-file'
    )
    expect(store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual({
      type: 'leaf',
      groupId: 'floating-group'
    })
    expect(store.getState().activeWorktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(store.getState().activeFileId).toBe('floating-file')
    expect(store.getState().activeTabId).toBe('floating-terminal-tab')
    expect(store.getState().activeTabType).toBe('editor')
  })
})
