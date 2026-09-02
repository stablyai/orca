import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../../shared/agent-status-types'
import { YOLO_TUI_AGENT_ARGS } from '../../../shared/tui-agent-permissions'
import {
  buildStoreState,
  expectWorktreeRouting,
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike
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

  it('does not send an out-of-order hook event to completion lifecycle tracking', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      updateTabTitle,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Claude' }]
      },
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'newer turn',
          agentType: 'claude',
          updatedAt: 1_700_000_000_500,
          stateStartedAt: 1_700_000_000_400
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
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationSettings: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'done',
      prompt: 'older turn',
      agentType: 'claude',
      receivedAt: 1_700_000_000_300,
      stateStartedAt: 1_700_000_000_200
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(updateTabTitle).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('keeps auto-approved Codex done statuses on the completion path', async () => {
    const setAgentStatus = vi.fn()
    const observeAgentHookCompletionForNotification = vi.fn()
    const getAgentLaunchConfigForStatusMetadata = vi.fn((metadata: { launchToken?: string }) =>
      metadata.launchToken === 'launch-yolo'
        ? { agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '', agentEnv: {} }
        : undefined
    )
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      getAgentLaunchConfigForStatusMetadata,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
      },
      terminalLayoutsByTabId: {}
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn(() => () => {}),
        getState: () => storeState
      }
    }))
    vi.doMock('./agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification,
      resetAgentHookCompletionNotificationCoordinators: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
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
      tabId: 'tab-future',
      worktreeId: 'wt-1',
      state: 'done',
      prompt: 'auto-approved task',
      agentType: 'codex',
      launchToken: 'launch-yolo',
      lastAssistantMessage: 'Done.',
      receivedAt: 1_700_000_000_500,
      stateStartedAt: 1_699_999_999_500
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(1)
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: FUTURE_PANE_KEY,
        worktreeId: 'wt-1',
        payload: expect.objectContaining({ state: 'done', agentType: 'codex' })
      })
    )
  })

  it('drops late push events for a recently closed terminal tab', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      recentlyClosedAgentStatusTabIds: { 'tab-future': true },
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
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
      prompt: 'late completion',
      agentType: 'codex',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps missing-tab runtime attribution for tabs that were never explicitly closed', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      recentlyClosedAgentStatusTabIds: {},
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: { 'wt-1': [] },
      terminalLayoutsByTabId: {}
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
      prompt: 'runtime child',
      agentType: 'codex',
      worktreeId: 'wt-1',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_000,
      orchestration: {
        parentPaneKey: 'parent-tab:11111111-1111-4111-8111-111111111111'
      }
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'runtime child', agentType: 'codex' }),
      undefined,
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_700_000_000_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })

  it('clears a worktree-attributed live row when main reports pane teardown', async () => {
    const setAgentStatus = vi.fn()
    const removeAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      removeAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: { 'wt-1': [] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'working',
          prompt: 'hidden worker',
          agentType: 'codex',
          updatedAt: 1_700_000_000_200,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          worktreeId: 'wt-1',
          stateHistory: []
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
        },
        onClear: (cb) => {
          onClearListenerRef.current = cb
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
    if (typeof onClearListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onClear listener to be registered')
    }

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'hidden worker',
      agentType: 'codex',
      worktreeId: 'wt-1',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_700_000_000_000,
      orchestration: {
        parentPaneKey: 'parent-tab:11111111-1111-4111-8111-111111111111'
      }
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ state: 'working', prompt: 'hidden worker', agentType: 'codex' }),
      undefined,
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_700_000_000_000 },
      expectWorktreeRouting('wt-1'),
      undefined
    )

    onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

    expect(removeAgentStatus).toHaveBeenCalledTimes(1)
    expect(removeAgentStatus).toHaveBeenCalledWith(FUTURE_PANE_KEY)
  })

  it('blocks cleared snapshots across remount and accepts newer reconnect replay', async () => {
    let resolveOldSnapshot!: (entries: AgentStatusSetData[]) => void
    let resolveCurrentSnapshot!: (entries: AgentStatusSetData[]) => void
    const oldSnapshot = new Promise<AgentStatusSetData[]>((resolve) => {
      resolveOldSnapshot = resolve
    })
    const currentSnapshot = new Promise<AgentStatusSetData[]>((resolve) => {
      resolveCurrentSnapshot = resolve
    })
    const effectCleanups: (() => void)[] = []
    const setAgentStatus = vi.fn()
    const clearTransientAgentStatuses = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = { current: null }
    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      clearTransientAgentStatuses,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      repos: [{ id: 'repo-1', connectionId: 'ssh-a' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Remote agent' }]
      },
      terminalLayoutsByTabId: {
        'tab-future': { root: { type: 'leaf', leafId: FUTURE_LEAF_ID } }
      }
    })

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof ReactModule>('react')
      return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
          const cleanup = effect()
          effectCleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
        }
      }
    })
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
        onSet: (callback) => {
          onSetListenerRef.current = callback
          return () => {}
        },
        onClear: (callback) => {
          onClearListenerRef.current = callback
          return () => {}
        },
        getSnapshot: vi.fn().mockReturnValueOnce(oldSnapshot).mockReturnValueOnce(currentSnapshot)
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()
    effectCleanups[0]?.()
    useIpcEvents()
    await Promise.resolve()
    if (!onSetListenerRef.current || !onClearListenerRef.current) {
      throw new Error('Expected agent status listeners to be registered')
    }

    expect(() =>
      onClearListenerRef.current?.(null as unknown as AgentStatusClearIpcPayload)
    ).not.toThrow()
    expect(clearTransientAgentStatuses).not.toHaveBeenCalled()

    onClearListenerRef.current({
      transient: true,
      connectionId: 'ssh-a',
      clearedAt: 100
    })
    const staleEntry: AgentStatusSetData = {
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'stale snapshot',
      agentType: 'codex',
      worktreeId: 'wt-1',
      connectionId: 'ssh-a',
      receivedAt: 100,
      stateStartedAt: 90
    }
    resolveOldSnapshot([staleEntry])
    resolveCurrentSnapshot([staleEntry])
    await Promise.resolve()
    await Promise.resolve()

    expect(clearTransientAgentStatuses).toHaveBeenCalledWith('ssh-a', 100)
    expect(setAgentStatus).not.toHaveBeenCalled()

    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'replayed',
      agentType: 'codex',
      worktreeId: 'wt-1',
      connectionId: 'ssh-a',
      receivedAt: 101,
      stateStartedAt: 101
    })

    expect(setAgentStatus).toHaveBeenCalledOnce()
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({ prompt: 'replayed' }),
      'Remote agent',
      { updatedAt: 101, stateStartedAt: 101 },
      expect.objectContaining({ worktreeId: 'wt-1', connectionId: 'ssh-a' }),
      undefined
    )
  })

  it('keeps a completed worktree-attributed row when main reports pane teardown', async () => {
    const removeAgentStatus = vi.fn()
    const onClearListenerRef: {
      current: ((data: AgentStatusClearIpcPayload) => void) | null
    } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      removeAgentStatus,
      workspaceSessionReady: true,
      agentStatusByPaneKey: {
        [FUTURE_PANE_KEY]: {
          state: 'done',
          prompt: 'hidden worker',
          agentType: 'codex',
          updatedAt: 1_700_000_000_200,
          stateStartedAt: 1_700_000_000_000,
          paneKey: FUTURE_PANE_KEY,
          worktreeId: 'wt-1',
          stateHistory: []
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
        onSet: () => () => {},
        onClear: (cb) => {
          onClearListenerRef.current = cb
          return () => {}
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')

    useIpcEvents()
    await Promise.resolve()

    if (typeof onClearListenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onClear listener to be registered')
    }

    onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

    expect(removeAgentStatus).not.toHaveBeenCalled()
  })

  it('does not retain a Cursor spinner terminal title when the hook reports done', async () => {
    const setAgentStatus = vi.fn()
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }

    const storeState: StoreLike = buildStoreState({
      setAgentStatus,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-future',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: '\u2839 Cursor Agent'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [FUTURE_LEAF_ID]: '\u2839 Cursor Agent' }
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
      prompt: 'cursor prompt',
      agentType: 'cursor',
      lastAssistantMessage: 'cursor completion',
      receivedAt: 1_700_000_000_200,
      stateStartedAt: 1_699_999_999_100
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'done',
        prompt: 'cursor prompt',
        agentType: 'cursor',
        lastAssistantMessage: 'cursor completion'
      }),
      'Cursor ready',
      { updatedAt: 1_700_000_000_200, stateStartedAt: 1_699_999_999_100 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
  })
})
