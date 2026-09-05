import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusUpdate } from '../store/slices/agent-status'
import { YOLO_TUI_AGENT_ARGS } from '../../../shared/tui-agent-permissions'
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

  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves queued set-clear order for working removal and done retention', async () => {
    vi.useFakeTimers()
    let storeState: StoreLike
    const applyStatusUpdate = (
      paneKey: string,
      payload: { state: string },
      timing: { updatedAt?: number } | undefined
    ): void => {
      storeState.agentStatusByPaneKey = {
        ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
        [paneKey]: { ...payload, updatedAt: timing?.updatedAt }
      }
    }
    const setAgentStatus = vi.fn(
      (
        paneKey: string,
        payload: { state: string },
        _title: unknown,
        timing: { updatedAt?: number } | undefined
      ) => {
        applyStatusUpdate(paneKey, payload, timing)
      }
    )
    const setAgentStatuses = vi.fn((updates: readonly AgentStatusUpdate[]) => {
      for (const update of updates) {
        applyStatusUpdate(update.paneKey, update.payload, update.timing)
      }
      return updates.map(() => true)
    })
    const removeAgentStatus = vi.fn((paneKey: string) => {
      const next = { ...(storeState.agentStatusByPaneKey as Record<string, unknown>) }
      delete next[paneKey]
      storeState.agentStatusByPaneKey = next
    })
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    const onClearListenerRef: { current: ((data: { paneKey: string }) => void) | null } = {
      current: null
    }
    storeState = buildStoreState({
      setAgentStatus,
      setAgentStatuses,
      removeAgentStatus,
      workspaceSessionReady: true,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
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
        },
        onClear: (cb) => {
          onClearListenerRef.current = cb as (data: { paneKey: string }) => void
          return () => {}
        }
      })
    )

    try {
      const { useIpcEvents } = await import('./useIpcEvents')
      useIpcEvents()
      if (
        typeof onSetListenerRef.current !== 'function' ||
        typeof onClearListenerRef.current !== 'function'
      ) {
        throw new Error('Expected agentStatus listeners to be registered')
      }
      const emit = (
        receivedAt: number,
        prompt: string,
        state: AgentStatusSetData['state'] = 'working'
      ): void => {
        onSetListenerRef.current!({
          paneKey: FUTURE_PANE_KEY,
          state,
          prompt,
          agentType: 'claude',
          receivedAt,
          stateStartedAt: receivedAt
        })
      }

      emit(1_700_000_000_000, 'leading')
      emit(1_700_000_000_001, 'queued')
      expect(setAgentStatus).toHaveBeenCalledTimes(1)

      onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })
      expect(removeAgentStatus).toHaveBeenCalledWith(FUTURE_PANE_KEY)
      expect(storeState.agentStatusByPaneKey).toEqual({})

      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(1)
      expect(setAgentStatuses).toHaveBeenCalledTimes(1)
      expect(storeState.agentStatusByPaneKey).toEqual({})

      emit(1_700_000_000_002, 'task')
      emit(1_700_000_000_003, 'task', 'done')
      expect(setAgentStatus).toHaveBeenCalledTimes(2)

      onClearListenerRef.current({ paneKey: FUTURE_PANE_KEY })

      expect(setAgentStatus).toHaveBeenCalledTimes(2)
      expect(setAgentStatuses).toHaveBeenCalledTimes(2)
      expect(setAgentStatuses.mock.calls[1][0][0]).toEqual(
        expect.objectContaining({ payload: expect.objectContaining({ state: 'done' }) })
      )
      expect(removeAgentStatus).toHaveBeenCalledTimes(1)
      expect(storeState.agentStatusByPaneKey).toEqual({
        [FUTURE_PANE_KEY]: expect.objectContaining({ state: 'done' })
      })
      vi.advanceTimersByTime(40)
      expect(setAgentStatus).toHaveBeenCalledTimes(2)
      expect(setAgentStatuses).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recurse when flushing a pending status re-enters via the store subscriber', async () => {
    // Repro for crash 9fc89529 (RangeError: Maximum call stack size exceeded):
    // the store subscriber retries pending statuses synchronously on hydration.
    // flush -> applyAgentStatus -> store.setAgentStatus notifies subscribers
    // synchronously (like Zustand) -> subscriber -> flush again while the same
    // event is still queued -> infinite recursion. Model setAgentStatus with a
    // real synchronous notify so the re-entrancy is exercised end to end.
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    let setAgentStatusCalls = 0
    const notify = (previousState: StoreLike = storeState): void => {
      const listener = subscribeListenerRef.current
      if (listener) {
        listener(storeState, previousState)
      }
    }
    const storeState: StoreLike = buildStoreState({
      // Why: mirror Zustand — a state mutation notifies subscribers synchronously.
      setAgentStatus: (paneKey: string, entry: unknown) => {
        setAgentStatusCalls += 1
        storeState.agentStatusByPaneKey = {
          ...(storeState.agentStatusByPaneKey as Record<string, unknown>),
          [paneKey]: entry
        }
        notify()
      },
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      // Pane does not exist yet -> the incoming event is buffered as pending.
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
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
    if (typeof subscribeListenerRef.current !== 'function') {
      throw new Error('Expected useAppStore.subscribe listener to be registered')
    }

    // Event lands before the tab exists -> buffered as a pending retry.
    onSetListenerRef.current({
      paneKey: FUTURE_PANE_KEY,
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_699_999_999_100
    })
    expect(setAgentStatusCalls).toBe(0)

    // Tab hydrates; the next store update flushes the pending event. Without the
    // re-entrancy guard this overflows the stack instead of applying once.
    const beforeHydration = { ...storeState }
    storeState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }

    expect(() => notify(beforeHydration)).not.toThrow()
    // Applied exactly once — the re-entrant flush is a no-op, not a loop.
    expect(setAgentStatusCalls).toBe(1)
  })

  // Why: the pending queue is spliced before the fold, so a throwing fold would drop every
  // buffered event permanently. Before batching the queue was only replaced after the loop,
  // so a throw left it intact — keep that.
  it('keeps pending statuses queued when the retry fold throws', async () => {
    vi.useFakeTimers()
    const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
    const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
      current: null
    }
    let shouldThrow = true
    const setAgentStatuses = vi.fn((updates: readonly AgentStatusUpdate[]) => {
      if (shouldThrow) {
        shouldThrow = false
        throw new Error('fold blew up')
      }
      return updates.map(() => true)
    })
    const storeState: StoreLike = buildStoreState({
      setAgentStatus: vi.fn(),
      setAgentStatuses,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      // Pane does not exist yet -> the incoming event is buffered as pending.
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
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
      prompt: 'buffered',
      agentType: 'claude',
      receivedAt: 1_700_000_000_100,
      stateStartedAt: 1_700_000_000_100
    })

    // The timer-owned retry throws after clearing its handle.
    expect(() => vi.advanceTimersByTime(100)).toThrow('fold blew up')

    // Hydrate without publishing so only the re-armed timer can recover the event.
    storeState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future Tab' }]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-future': {
        root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
        activeLeafId: FUTURE_LEAF_ID,
        expandedLeafId: null
      }
    }

    vi.advanceTimersByTime(100)
    const replayedAfterThrow = setAgentStatuses.mock.calls
      .slice(1)
      .flatMap((call) => call[0].map((update) => update.payload.prompt))
    expect(replayedAfterThrow).toContain('buffered')
  })

  it('applies ready push events for an unmounted inactive terminal tab', async () => {
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

  it('suppresses auto-approved Codex permission attention before status and title mutation', async () => {
    const setAgentStatus = vi.fn()
    const updateTabTitle = vi.fn()
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
      updateTabTitle,
      getAgentLaunchConfigForStatusMetadata,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: true, agentTaskComplete: true } },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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
      state: 'waiting',
      prompt: 'auto-approved permission',
      agentType: 'codex',
      launchToken: 'launch-yolo',
      receivedAt: 1_700_000_000_300,
      stateStartedAt: 1_699_999_999_300
    })

    expect(getAgentLaunchConfigForStatusMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: FUTURE_PANE_KEY, launchToken: 'launch-yolo' })
    )
    expect(setAgentStatus).not.toHaveBeenCalled()
    expect(updateTabTitle).not.toHaveBeenCalled()
    expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
  })

  it('keeps manual or missing-attribution Codex permission attention actionable', async () => {
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
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Codex' }]
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
      state: 'waiting',
      prompt: 'manual permission',
      agentType: 'codex',
      receivedAt: 1_700_000_000_400,
      stateStartedAt: 1_699_999_999_400
    })

    expect(setAgentStatus).toHaveBeenCalledTimes(1)
    expect(setAgentStatus).toHaveBeenCalledWith(
      FUTURE_PANE_KEY,
      expect.objectContaining({
        state: 'waiting',
        prompt: 'manual permission',
        agentType: 'codex'
      }),
      'Codex - action required',
      { updatedAt: 1_700_000_000_400, stateStartedAt: 1_699_999_999_400 },
      expectWorktreeRouting('wt-1'),
      undefined
    )
    expect(updateTabTitle).toHaveBeenCalledWith('tab-future', 'Codex - action required')
    expect(observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(1)
  })
})
