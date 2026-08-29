import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  expectWorktreeRouting,
  FUTURE_LEAF_ID,
  ORPHAN_LEAF_ID,
  TAB_1_LEAF_ID,
  STALE_PANE_KEY,
  ORPHAN_PANE_KEY,
  TAB_1_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike,
  type StoreSubscribeListener
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'

describe('useIpcEvents agent status snapshot integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('pulls the snapshot once workspace session is ready even before settings load', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() => Promise.resolve([]))
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {},
      workspaceSessionReady: true,
      settings: null
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          subscribeListenerRef.current = listener
          return () => {
            subscribeListenerRef.current = null
          }
        }),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('waits for the remote workspace client id before dropping self notifications', async () => {
    const hydrateWorkspaceSession = vi.fn()
    const hydrateTabsSession = vi.fn()
    const hydrateEditorSession = vi.fn()
    const hydrateBrowserSession = vi.fn()
    let resolveClientId!: (id: string) => void
    const clientId = new Promise<string>((resolve) => {
      resolveClientId = resolve
    })
    const onChangedListenerRef: {
      current:
        | ((event: {
            targetId: string
            sourceClientId?: string
            snapshot: Record<string, unknown>
          }) => void)
        | null
    } = { current: null }
    const storeState: StoreLike = buildStoreState({
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/repo', repoId: 'repo-1' }] },
      hydrateWorkspaceSession,
      hydrateTabsSession,
      hydrateEditorSession,
      hydrateBrowserSession,
      markRemoteWorkspaceHydrated: vi.fn(),
      setRemoteWorkspaceSyncStatus: vi.fn(),
      reconnectPersistedTerminals: vi.fn(() => Promise.resolve())
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        remoteWorkspace: {
          clientId: () => clientId,
          onChanged: (cb: typeof onChangedListenerRef.current) => {
            onChangedListenerRef.current = cb
            return () => {}
          }
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    onChangedListenerRef.current?.({
      targetId: 'conn-1',
      sourceClientId: 'client-self',
      snapshot: {
        revision: 1,
        updatedAt: Date.now(),
        session: {
          activeWorktreePath: '/repo',
          activeTabId: 'tab-1',
          tabsByWorktreePath: {
            '/repo': [
              {
                id: 'tab-1',
                ptyId: null,
                worktreePath: '/repo',
                title: 'Remote',
                customTitle: null,
                color: null,
                sortOrder: 1,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {}
        }
      }
    })
    await Promise.resolve()
    expect(hydrateWorkspaceSession).not.toHaveBeenCalled()

    resolveClientId('client-self')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(hydrateWorkspaceSession).not.toHaveBeenCalled()
    expect(hydrateTabsSession).not.toHaveBeenCalled()
    expect(hydrateEditorSession).not.toHaveBeenCalled()
    expect(hydrateBrowserSession).not.toHaveBeenCalled()
  })

  it('silently discards snapshot entries whose tabs are still unknown', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'done' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-other', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Other' }]
      },
      terminalLayoutsByTabId: {
        'tab-orphan': {
          root: { type: 'leaf', leafId: ORPHAN_LEAF_ID },
          activeLeafId: ORPHAN_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('silently discards stale worktree-attributed snapshots for unknown panes', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'done' as const,
          prompt: 'old copilot turn',
          agentType: 'copilot',
          worktreeId: 'wt-1',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Copilot' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('applies worktree-attributed child snapshots when runtime identity is present', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: ORPHAN_PANE_KEY,
          state: 'working' as const,
          prompt: 'child task',
          agentType: 'codex',
          worktreeId: 'wt-1',
          terminalHandle: 'term-child',
          orchestration: {
            taskId: 'task-child',
            dispatchId: 'dispatch-child',
            parentTerminalHandle: 'term-parent'
          },
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      ORPHAN_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'child task',
        agentType: 'codex',
        orchestration: expect.objectContaining({ taskId: 'task-child' })
      }),
      undefined,
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expect.objectContaining({ worktreeId: 'wt-1', terminalHandle: 'term-child' }),
      undefined
    )
  })

  it('silently discards valid paneKeys whose leaf is not in the current layout', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: STALE_PANE_KEY,
          state: 'done' as const,
          prompt: 'p',
          agentType: 'claude',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      workspaceSessionReady: true
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('forwards events whose connectionId matches the live repo connection', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-1',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledWith(
      TAB_1_PANE_KEY,
      expect.objectContaining({ state: 'working' }),
      'Terminal 1',
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('drops events whose connectionId no longer matches the live local repo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-stale',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('drops remote-stamped events when the owning worktree is no longer in worktreesByRepo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: { 'repo-1': [] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      connectionId: 'conn-other',
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('accepts events without a stamped connectionId for preload compatibility', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
          activeLeafId: TAB_1_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    onSetListenerRef.current?.({
      paneKey: TAB_1_PANE_KEY,
      state: 'working',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
  })
})
