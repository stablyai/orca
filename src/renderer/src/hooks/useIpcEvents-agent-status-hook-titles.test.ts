import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import type { AppState } from '../store/types'
import {
  buildStoreState,
  expectWorktreeRouting,
  FUTURE_LEAF_ID,
  STALE_LEAF_ID,
  FUTURE_PANE_KEY,
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

  it('does not retain a Codex spinner terminal title when the hook reports done', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: '\u280b Codex'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [FUTURE_LEAF_ID]: '\u280b Codex' }
        }
      }
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
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'codex prompt',
      agentType: 'codex',
      lastAssistantMessage: 'codex completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        lastAssistantMessage: 'codex completion'
      }),
      'Codex ready',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(updateTabTitle).toHaveBeenCalledTimes(1)
    expect(updateTabTitle).toHaveBeenCalledWith('tab-future', 'Codex ready')
  })

  it('drops nested child done push events when the parent pane agent is still active', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'parent codex',
          agentType: 'codex',
          updatedAt: 1_700_000_000_000,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          stateHistory: []
        }
      },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [FUTURE_LEAF_ID]: 'pty-1' }
        }
      },
      ptyIdsByTabId: { 'tab-future': ['pty-1'] }
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
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'nested claude',
      agentType: 'claude',
      lastAssistantMessage: 'child finished',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_200
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps OpenClaude hook status distinct when it arrives through Claude-compatible hooks', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 2' }]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            entityId: 'tab-future',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            label: 'openclaude.exe',
            customLabel: null,
            sortOrder: 0,
            createdAt: 1_700_000_000_000
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
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
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'OpenClaude prompt',
      agentType: 'claude',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'OpenClaude prompt',
        agentType: 'openclaude'
      }),
      'Terminal 2',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('applies ready push events for inactive terminal tabs with empty layout snapshots', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Inactive Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
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
        onSet: (cb) => {
          onSetListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'inactive prompt',
      agentType: 'codex',
      lastAssistantMessage: 'inactive completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'inactive prompt',
        agentType: 'codex',
        lastAssistantMessage: 'inactive completion'
      }),
      'Inactive Tab',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('buffers ready push events until a mounted tab contains the pane leaf', async () => {
    const setAgentStatus = vi.fn()
    const track = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: STALE_LEAF_ID },
          activeLeafId: STALE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    const setAgentStatusBatch = vi.mocked(
      storeState.setAgentStatuses as AppState['setAgentStatuses']
    )

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
    vi.doMock('@/lib/telemetry', () => ({ track }))
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

    if (typeof onSetListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onSet listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'queued prompt',
      agentType: 'codex',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'done',
      prompt: 'queued prompt',
      agentType: 'codex',
      lastAssistantMessage: 'queued completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'unknown_tab_id'
    })

    const previousStoreState = { ...storeState }
    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }
    subscribeListenerRef.current(storeState, previousStoreState)

    expect(setAgentStatus).toHaveBeenCalledTimes(2)
    expect(setAgentStatusBatch).toHaveBeenCalledTimes(1)
    expect(setAgentStatusBatch.mock.calls[0]?.[0]).toHaveLength(2)
    expect(setAgentStatus).toHaveBeenNthCalledWith(
      1,
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'queued prompt', agentType: 'codex' }),
      'Future Tab',
      { updatedAt: 1_700_000_000_100, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(setAgentStatus).toHaveBeenNthCalledWith(
      2,
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'queued prompt',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion'
      }),
      'Future Tab',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('applies remote status snapshots while repo ownership is still hydrating', async () => {
    const setAgentStatus = vi.fn()
    const getSnapshot = vi.fn(() =>
      Promise.resolve([
        {
          paneKey: FUTURE_PANE_KEY,
          state: 'working' as const,
          prompt: 'remote p',
          agentType: 'codex',
          worktreeId: 'wt-1',
          connectionId: 'ssh-1',
          receivedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000
        }
      ])
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      repos: [],
      worktreesByRepo: {}
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

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'remote p', agentType: 'codex' }),
      'SSH Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('preserves a SessionStart boundary from snapshot IPC without completion side effects', async () => {
    const now = Date.now()
    const refreshGitHubForWorktreeIfStale = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      repos: [{ ...TEST_REPO, connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
      },
      tabsByWorktree: {
        'wt-1': [
          makeTab({
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'Claude'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      refreshGitHubForWorktreeIfStale
    })
    store
      .getState()
      .setAgentStatus(
        FUTURE_PANE_KEY,
        { state: 'working', prompt: 'resumed task', agentType: 'claude' },
        'Claude',
        { updatedAt: now - 2, stateStartedAt: now - 2 },
        { tabId: 'tab-future', worktreeId: 'wt-1' }
      )

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: store.subscribe,
        getState: store.getState
      }
    }))
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        getSnapshot: () =>
          Promise.resolve([
            {
              paneKey: FUTURE_PANE_KEY,
              tabId: 'tab-future',
              worktreeId: 'wt-1',
              state: 'done',
              prompt: '',
              agentType: 'claude',
              sessionBoundary: true,
              receivedAt: now,
              stateStartedAt: now
            }
          ]),
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()

    await vi.waitFor(() => {
      expect(store.getState().agentStatusByPaneKey[FUTURE_PANE_KEY]).toMatchObject({
        state: 'done',
        sessionBoundary: true
      })
    })
    await Promise.resolve()

    expect(refreshGitHubForWorktreeIfStale).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })
})
