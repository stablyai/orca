/**
 * A session mutation made while the direct-SSH write gate is closed must be deferred, never
 * dropped.
 *
 * Why this is data loss and not a delay: the subscriber advances its change-detection baseline
 * (`prev = next`) before it consults the gate, and detection is identity-based
 * (`prev[key] !== next[key]`). A field cleared out of the pending set at that point can never be
 * re-detected, so the mutation is gone until something else happens to touch the same field. The
 * gate is closed for up to SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS plus a 1s tail on every SSH
 * connect and reconnect — and a tab closed in that window loses both the removal and the tombstone
 * that was supposed to stop the host from resurrecting it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

let initialState: AppState

function terminalTab(id: string, worktreeId: string): AppState['tabsByWorktree'][string][number] {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    defaultTitle: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** Stands in for the direct-SSH apply gate: `isOpen` is the flag, and the wake-up fires on demand
 *  the way the apply's suppression tail fires it. */
function createTestPersistGate(isOpen: () => boolean) {
  const listeners: (() => void)[] = []
  return {
    deps: {
      shouldSchedulePersist: isOpen,
      subscribeToPersistGateOpen: (onGateOpen: () => void) => {
        listeners.push(onGateOpen)
        return () => {
          listeners.length = 0
        }
      }
    },
    listenerCount: (): number => listeners.length,
    notifyGateOpen: (): void => {
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

describe('session write subscriber defers writes across a closed persistence gate', () => {
  beforeEach(() => {
    initialState = useAppStore.getState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('writes a mutation made while the gate was closed once a later mutation reopens it', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...createTestPersistGate(() => gateOpen).deps
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    // The user closes an SSH tab while a snapshot apply is running.
    gateOpen = false
    useAppStore.setState({
      activeTabId: 'still-open-tab',
      closedTerminalTabTombstonesByTabId: {
        'closed-during-apply': {
          closedAt: Date.now(),
          worktreeId: 'wt-remote'
        }
      }
    })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    // The apply finishes and an unrelated field changes. The deferred close must ride along.
    gateOpen = true
    useAppStore.setState({ activeRepoId: 'repo-1' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    const patch = persist.mock.calls[0][0].patch
    expect(
      patch.closedTerminalTabTombstonesByTabId,
      'the tombstone written during the apply window was discarded, not deferred'
    ).toEqual({
      'closed-during-apply': {
        closedAt: expect.any(Number),
        worktreeId: 'wt-remote'
      }
    })
    expect(patch.activeTabId).toBe('still-open-tab')
    expect(patch.activeRepoId).toBe('repo-1')
    cleanup()
  })

  it('writes a mutation whose debounce expired inside the apply window', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...createTestPersistGate(() => gateOpen).deps
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    // Mutation lands with the gate open, but the apply starts before the debounce expires.
    useAppStore.setState({ activeTabId: 'closed-mid-debounce' })
    vi.advanceTimersByTime(50)
    gateOpen = false
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    gateOpen = true
    useAppStore.setState({ activeRepoId: 'repo-2' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(
      persist.mock.calls[0][0].patch.activeTabId,
      'the debounce fired inside the apply window and threw the mutation away'
    ).toBe('closed-mid-debounce')
    cleanup()
  })

  it('keeps an unrelated target’s tab close across another target’s apply', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...createTestPersistGate(() => gateOpen).deps
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      tabsByWorktree: {
        'wt-target-a': [terminalTab('tab-a', 'wt-target-a')],
        'wt-target-b': [terminalTab('tab-b', 'wt-target-b')]
      }
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    // The gate is global: target A's apply suppresses writes for every other target too.
    gateOpen = false
    useAppStore.setState({
      tabsByWorktree: {
        'wt-target-a': [terminalTab('tab-a', 'wt-target-a')],
        'wt-target-b': []
      },
      closedTerminalTabTombstonesByTabId: {
        'tab-b': { closedAt: Date.now(), worktreeId: 'wt-target-b' }
      }
    })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    gateOpen = true
    useAppStore.setState({ activeRepoId: 'repo-3' })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    const patch = persist.mock.calls[0][0].patch
    expect(
      patch.tabsByWorktree?.['wt-target-b'],
      'target B lost a tab close because target A was mid-apply'
    ).toEqual([])
    expect(patch.tabsByWorktree?.['wt-target-a']).toHaveLength(1)
    expect(patch.closedTerminalTabTombstonesByTabId?.['tab-b']?.worktreeId).toBe('wt-target-b')
    cleanup()
  })

  it('writes on the gate-open wake-up when no further store update follows', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const gate = createTestPersistGate(() => gateOpen)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...gate.deps
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    gateOpen = false
    useAppStore.setState({ activeTabId: 'closed-during-apply' })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    // The suppression tail expires on a wall clock, so nothing touches the store afterwards.
    gateOpen = true
    expect(gate.listenerCount(), 'the subscriber never registered for the gate-open wake-up').toBe(
      1
    )
    gate.notifyGateOpen()
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('closed-during-apply')
    cleanup()
  })

  it('arms no timer while the gate stays closed', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...createTestPersistGate(() => gateOpen).deps
    })

    useAppStore.setState({
      workspaceSessionReady: true,
      hydrationSucceeded: true
    })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    gateOpen = false
    useAppStore.setState({ activeTabId: 'closed-during-apply' })
    vi.advanceTimersByTime(10_000)

    expect(persist).not.toHaveBeenCalled()
    // A gate that never reopens must not turn deferral into a polling loop.
    expect(vi.getTimerCount(), 'the deferred write is polling on a re-armed timer').toBe(0)
    cleanup()
  })

  it('does not let an unrelated update reset a debounce armed by the gate-open wake-up', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    let gateOpen = true
    const gate = createTestPersistGate(() => gateOpen)
    const cleanup = createSessionWriteSubscriber({
      store: useAppStore,
      persist,
      ...gate.deps
    })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    gateOpen = false
    useAppStore.setState({ activeTabId: 'closed-during-apply' })
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled()

    // The wake-up arms the debounce; agent-status and usage ticks keep arriving while it runs.
    gateOpen = true
    gate.notifyGateOpen()
    vi.advanceTimersByTime(100)
    useAppStore.getState().setCacheTimerStartedAt('tab-1:pane-1', Date.now())
    vi.advanceTimersByTime(60)

    expect(
      persist,
      'an unrelated update pushed the deferred write past its debounce'
    ).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].patch.activeTabId).toBe('closed-during-apply')
    cleanup()
  })
})
