import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/types'
import { useAppStore, type AppState } from '@/store'
import { createSessionWriteSubscriber } from './session-write-subscriber'

// Why: useAppStore is a module-level singleton — tests must snapshot and
// restore the full state around each case so cross-test pollution can't mask
// a real regression in the gate logic this suite exists to lock down.
let initialState: AppState

describe('createSessionWriteSubscriber', () => {
  beforeEach(() => {
    initialState = useAppStore.getState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('does not write while workspaceSessionReady is false', () => {
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ tabsByWorktree: { 'wt-1': [] } })
    vi.advanceTimersByTime(200)

    expect(persist).not.toHaveBeenCalled()
    cleanup()
  })

  it('writes exactly once after workspaceSessionReady flips to true', () => {
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true })
    vi.advanceTimersByTime(200)

    expect(persist).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('ignores mutations to fields outside SESSION_RELEVANT_FIELDS', () => {
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true })
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

  it('writes exactly once when a relevant field changes', () => {
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true })
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

  it('coalesces multiple relevant mutations within a debounce window', () => {
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true })
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
    const persist = vi.fn<(payload: WorkspaceSessionState) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true })
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
