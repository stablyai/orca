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

  it('re-checks the hydration gate when a pending debounce fires', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(50)
    useAppStore.setState({ hydrationSucceeded: false })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
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

  it('updates its baseline without scheduling when shouldSchedulePersist returns false', () => {
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
    cleanup()
  })

  it('cancels a pending debounce when shouldSchedulePersist returns false', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let shouldSchedule = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      shouldSchedulePersist: () => shouldSchedule
    })

    useAppStore.setState({ workspaceSessionReady: true })
    vi.advanceTimersByTime(50)
    shouldSchedule = false
    useAppStore.setState({ activeTabId: 'remote-tab' })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('re-checks shouldSchedulePersist when a pending debounce fires', () => {
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
