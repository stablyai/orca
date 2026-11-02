import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  expectWorktreeRouting,
  FUTURE_LEAF_ID,
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

  it('queues replayed startup snapshots until the pane hydrates', async () => {
    const setAgentStatus = vi.fn()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      worktreesByRepo: {}
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

    resolveSnapshot([
      {
        paneKey: FUTURE_PANE_KEY,
        tabId: 'tab-future',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        state: 'working',
        prompt: 'PreToolUse: Bash',
        agentType: 'codex',
        toolName: 'Bash',
        toolInput: 'pnpm test',
        terminalHandle: 'term-future',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000,
        // A reload starts with no state history; the host's turn start must arrive with the row.
        turnStartedAt: 1_699_999_990_000
      }
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()

    const beforeHydration = { ...storeState }
    Object.assign(storeState, {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    subscribeListenerRef.current?.(storeState, beforeHydration)

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'working',
        prompt: 'PreToolUse: Bash',
        agentType: 'codex',
        toolName: 'Bash',
        toolInput: 'pnpm test'
      }),
      'SSH Tab',
      {
        updatedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000,
        turnStartedAt: 1_699_999_990_000
      },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('suppresses notifications for replayed done snapshots after pane hydration', async () => {
    const setAgentStatus = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    let resolveSnapshot!: (entries: AgentStatusSetData[]) => void
    const getSnapshot = vi.fn(
      () =>
        new Promise<AgentStatusSetData[]>((resolve) => {
          resolveSnapshot = resolve
        })
    )

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      worktreesByRepo: {}
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
        getSnapshot,
        onSet: () => () => {}
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    resolveSnapshot([
      {
        paneKey: FUTURE_PANE_KEY,
        tabId: 'tab-future',
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        state: 'done',
        prompt: 'remote completion',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion',
        terminalHandle: 'term-future',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(setAgentStatus).not.toHaveBeenCalled()

    const beforeHydration = { ...storeState }
    Object.assign(storeState, {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'SSH Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    subscribeListenerRef.current?.(storeState, beforeHydration)

    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'remote completion',
        agentType: 'codex',
        lastAssistantMessage: 'queued completion'
      }),
      'SSH Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('accepts WSL-relayed status events for a local repo (wsl:* is transport provenance, not ownership)', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'WSL Tab' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
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
      prompt: 'wsl p',
      agentType: 'claude',
      worktreeId: 'wt-1',
      connectionId: 'wsl:Ubuntu',
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'wsl p', agentType: 'claude' }),
      'WSL Tab',
      { updatedAt: 1_700_000_000_000, stateStartedAt: 1_699_999_999_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('still rejects WSL-relayed status events against an SSH-owned repo', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
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
      repos: [{ id: 'repo-1', connectionId: 'ssh-1' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
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
      prompt: 'wsl p',
      agentType: 'claude',
      worktreeId: 'wt-1',
      connectionId: 'wsl:Ubuntu',
      receivedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })
})
