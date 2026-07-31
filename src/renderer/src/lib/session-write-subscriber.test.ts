import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

// Why: useAppStore is a module-level singleton — tests must snapshot and
// restore the full state around each case so cross-test pollution can't mask
// a real regression in the gate logic this suite exists to lock down.
let initialState: AppState

function makeTerminalSessionState(title: string, label = title): Partial<AppState> {
  return {
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title,
          defaultTitle: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          entityId: 'tab-1',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          label,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: 'tab-1',
          tabOrder: ['tab-1']
        }
      ]
    },
    layoutByWorktree: {
      'wt-1': { type: 'leaf', groupId: 'group-1' }
    },
    activeGroupIdByWorktree: {
      'wt-1': 'group-1'
    }
  }
}

describe('createSessionWriteSubscriber', () => {
  beforeEach(() => {
    initialState = useAppStore.getState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('does not write until both workspaceSessionReady and hydrationSucceeded are true', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ tabsByWorktree: { 'wt-1': [] } })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    useAppStore.setState({ workspaceSessionReady: true })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('writes exactly once after the hydration persistence gate opens', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('retains a pending batch while the hydration gate closes and reopens', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'retained-through-gate'
    })
    vi.advanceTimersByTime(50)
    useAppStore.setState({ hydrationSucceeded: false })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()

    useAppStore.setState({ hydrationSucceeded: true })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('retained-through-gate')
    cleanup()
  })

  it('ignores mutations to fields outside SESSION_RELEVANT_FIELDS', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    expect(persist).toHaveBeenCalledTimes(1)
    persist.mockClear()

    // setAgentStatus / setCacheTimerStartedAt mutate fields that are NOT in
    // SESSION_RELEVANT_FIELDS — the gate must skip the timer reset entirely.
    useAppStore.getState().setAgentStatus('tab-1:1', {
      state: 'working',
      prompt: 'Fix tests',
      agentType: 'codex'
    })
    useAppStore.getState().setCacheTimerStartedAt('tab-1:pane-1', Date.now())
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('writes a live agent recovery checkpoint when provider session metadata arrives', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'Codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    } as never)
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'Fix tests',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledWith({
      patch: {
        sleepingAgentSessionsByPaneKey: {
          'tab-1:leaf-1': expect.objectContaining({
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            origin: 'live'
          })
        }
      }
    })
    cleanup()
  })

  it('writes exactly once when a relevant field changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    expect(persist).toHaveBeenCalledTimes(1)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: 'wt-1',
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('ignores decorative terminal title-only churn', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('⠋ Codex is thinking')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().tabsByWorktree['wt-1'][0],
            title: '⠙ Codex is thinking'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('persists ordinary terminal title-only changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('bash')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().tabsByWorktree['wt-1'][0],
            title: 'vim src/index.ts'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.tabsByWorktree?.['wt-1']?.[0]?.title).toBe(
      'vim src/index.ts'
    )
    cleanup()
  })

  it('persists terminal defaultTitle-only changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('bash')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().tabsByWorktree['wt-1'][0],
            defaultTitle: 'Terminal 2'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.tabsByWorktree?.['wt-1']?.[0]?.defaultTitle).toBe(
      'Terminal 2'
    )
    cleanup()
  })

  it('ignores pendingActivationSpawn-only changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('bash')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().tabsByWorktree['wt-1'][0],
            pendingActivationSpawn: true
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('ignores decorative unified terminal label churn', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('⠋ Codex is thinking')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().unifiedTabsByWorktree['wt-1'][0],
            label: '⠙ Codex is thinking'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('persists ordinary unified terminal label changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('bash')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().unifiedTabsByWorktree['wt-1'][0],
            label: 'vim src/index.ts'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.unifiedTabs?.['wt-1']?.[0]?.label).toBe(
      'vim src/index.ts'
    )
    cleanup()
  })

  it('ignores production updateTabTitle spinner frames across terminal and unified tabs', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('⠋ Codex is thinking')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.getState().updateTabTitle('tab-1', '⠙ Codex is thinking')
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('persists production updateTabTitle for ordinary terminal titles', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('bash')
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.getState().updateTabTitle('tab-1', 'vim src/index.ts')
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.tabsByWorktree?.['wt-1']?.[0]?.title).toBe(
      'vim src/index.ts'
    )
    expect(persist.mock.calls[0][0].patch.unifiedTabs?.['wt-1']?.[0]?.label).toBe(
      'vim src/index.ts'
    )
    cleanup()
  })

  it('persists real terminal tab changes even when the title also changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'Codex ready',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...useAppStore.getState().tabsByWorktree['wt-1'][0],
            title: 'renamed terminal',
            customTitle: 'renamed terminal'
          }
        ]
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.tabsByWorktree?.['wt-1']?.[0]?.customTitle).toBe(
      'renamed terminal'
    )
    cleanup()
  })

  it('writes a narrow patch when only the active tab changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({ activeTabId: 'tab-perf-1' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch).toEqual({ activeTabId: 'tab-perf-1' })
    cleanup()
  })

  it('writes when live PTY bindings change without terminal tab changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({
      ptyIdsByTabId: {
        ...useAppStore.getState().ptyIdsByTabId,
        'tab-1': []
      }
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('retains its baseline while scheduling is suppressed', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = false
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    useAppStore.setState({ activeTabId: 'tab-1' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('tab-1')
    cleanup()
  })
  it('flushes retained fields when suppression lifts without another store notification', async () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = false
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'self-scheduled-tab'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    await vi.advanceTimersByTimeAsync(100)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('self-scheduled-tab')
    cleanup()
  })

  it('restores the captured batch and retries after a synchronous persist failure', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const persist = vi
      .fn<(payload: WorkspaceSessionWrite) => void>()
      .mockImplementationOnce(() => {
        throw new Error('disk unavailable')
      })
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'sync-retry-tab'
    })
    vi.advanceTimersByTime(100)
    expect(persist).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch.activeTabId).toBe('sync-retry-tab')
    expect(consoleError).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('restores the captured batch and retries after an async persist rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const persist = vi
      .fn<(payload: WorkspaceSessionWrite) => Promise<void>>()
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValue(undefined)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'async-retry-tab'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch.activeTabId).toBe('async-retry-tab')
    expect(consoleError).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('serializes an in-flight write before flushing newer pending state', async () => {
    let resolveFirstPersist!: () => void
    const firstPersist = new Promise<void>((resolve) => {
      resolveFirstPersist = resolve
    })
    const persist = vi
      .fn<(payload: WorkspaceSessionWrite) => Promise<void>>()
      .mockImplementationOnce(() => firstPersist)
      .mockResolvedValue(undefined)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'first-write-tab'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).toHaveBeenCalledTimes(1)

    useAppStore.setState({ activeRepoId: 'repo-after-first-write' })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).toHaveBeenCalledTimes(1)

    resolveFirstPersist()
    await vi.advanceTimersByTimeAsync(99)
    expect(persist).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch.activeRepoId).toBe('repo-after-first-write')
    cleanup()
  })
  it('does not retry or report an async rejection after cleanup', async () => {
    let rejectPersist!: (reason?: unknown) => void
    const persist = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPersist = reject
        })
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'disposed-retry-tab'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).toHaveBeenCalledTimes(1)

    cleanup()
    rejectPersist(new Error('late rejection'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('unions fresh changes into a failed in-flight batch without delaying their timer', async () => {
    let rejectFirstPersist!: (reason?: unknown) => void
    const firstPersist = new Promise<void>((_resolve, reject) => {
      rejectFirstPersist = reject
    })
    const persist = vi
      .fn<(payload: WorkspaceSessionWrite) => Promise<void>>()
      .mockImplementationOnce(() => firstPersist)
      .mockResolvedValue(undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      debounceMs: 100
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      activeTabId: 'in-flight-tab'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(persist).toHaveBeenCalledTimes(1)

    useAppStore.setState({ activeRepoId: 'repo-during-write' })
    rejectFirstPersist(new Error('first write failed'))
    await vi.advanceTimersByTimeAsync(99)
    expect(persist).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0].patch).toMatchObject({
      activeTabId: 'in-flight-tab',
      activeRepoId: 'repo-during-write'
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('persists a coherent projection bundle after the first eligible write is dropped', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = false
    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: false,
      ...makeTerminalSessionState('Terminal 1')
    })
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    useAppStore.getState().setCacheTimerStartedAt('projection-replay', 1)
    vi.advanceTimersByTime(100)
    useAppStore.getState().setCacheTimerStartedAt('projection-replay', 2)
    vi.advanceTimersByTime(60)

    expect(persist).toHaveBeenCalledTimes(1)
    const patch = persist.mock.calls[0][0].patch
    expect(patch).toEqual(
      expect.objectContaining({
        unifiedTabs: expect.objectContaining({ 'wt-1': expect.any(Array) }),
        tabGroups: expect.objectContaining({ 'wt-1': expect.any(Array) }),
        tabGroupLayouts: expect.objectContaining({ 'wt-1': expect.any(Object) }),
        activeGroupIdByWorktree: expect.objectContaining({ 'wt-1': 'group-1' })
      })
    )
    expect(patch.unifiedTabs).toBeDefined()
    expect(patch.tabGroups).toBeDefined()
    expect(patch.tabGroupLayouts).toBeDefined()
    expect(patch.activeGroupIdByWorktree).toBeDefined()
    const persistedTab = patch.unifiedTabs!['wt-1'][0]
    const persistedGroup = patch.tabGroups!['wt-1'][0]
    expect(persistedTab).toMatchObject({
      id: 'tab-1',
      entityId: 'tab-1',
      groupId: 'group-1',
      label: 'Terminal 1'
    })
    expect(persistedGroup).toMatchObject({
      id: 'group-1',
      activeTabId: 'tab-1',
      tabOrder: ['tab-1']
    })
    expect(patch.tabGroupLayouts!['wt-1']).toEqual({
      type: 'leaf',
      groupId: persistedGroup.id
    })
    expect(patch.activeGroupIdByWorktree!['wt-1']).toBe(persistedGroup.id)

    useAppStore.getState().setCacheTimerStartedAt('projection-replay', 3)
    vi.advanceTimersByTime(200)
    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('retains pending fields when suppression cancels an armed debounce', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(50)
    shouldSchedule = false
    useAppStore.setState({ activeTabId: 'remote-tab' })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    useAppStore.getState().setCacheTimerStartedAt('cancelled-debounce-replay', 1)
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('remote-tab')
    cleanup()
  })
  it('unions distinct relevant fields across one suppression window', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    shouldSchedule = false
    useAppStore.setState({ activeRepoId: 'repo-during-suppression' })
    vi.advanceTimersByTime(200)
    useAppStore.setState({ activeWorktreeId: 'worktree-during-suppression' })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    useAppStore.getState().setCacheTimerStartedAt('union-replay', 1)
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch).toMatchObject({
      activeRepoId: 'repo-during-suppression',
      activeWorktreeId: 'worktree-during-suppression'
    })
    cleanup()
  })

  it('retains pending fields when suppression begins as the debounce fires', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({ activeWorktreeId: 'wt-before-remote-pull' })
    vi.advanceTimersByTime(50)
    shouldSchedule = false
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    shouldSchedule = true
    useAppStore.getState().setCacheTimerStartedAt('expired-debounce-replay', 1)
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeWorktreeId).toBe('wt-before-remote-pull')
    cleanup()
  })

  it('restarts a pending replay debounce only for a new relevant change', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = false
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    shouldSchedule = true
    useAppStore.getState().setCacheTimerStartedAt('pending-replay', 1)
    vi.advanceTimersByTime(50)

    useAppStore.setState({ activeTabId: 'new-relevant-tab' })
    vi.advanceTimersByTime(149)
    expect(persist).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('new-relevant-tab')
    cleanup()
  })

  it('coalesces multiple relevant mutations within a debounce window', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({ activeRepoId: 'repo-1' })
    vi.advanceTimersByTime(50)
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    vi.advanceTimersByTime(50)
    useAppStore.setState({ activeTabId: 'tab-1' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('rebuilds a pending tab patch after close so it cannot resurrect the tab', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ...makeTerminalSessionState('shell')
    })
    vi.advanceTimersByTime(50)
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      groupsByWorktree: { 'wt-1': [] },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      activeTabId: null
    })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.tabsByWorktree?.['wt-1']).toEqual([])
    expect(persist.mock.calls[0][0].patch.unifiedTabs?.['wt-1']).toBeUndefined()
    cleanup()
  })

  it('cleanup unsubscribes and cancels a pending timer', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.setState({ activeTabId: 'tab-1' })
    cleanup()
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()

    // Why: without this second mutation, the assertion above only proves the
    // pending timer was cancelled — a regression where cleanup() forgot to
    // unsub() would still pass. Mutating after cleanup verifies the listener
    // was detached and no new timer is queued.
    useAppStore.setState({ activeTabId: 'tab-2' })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()
  })
})
