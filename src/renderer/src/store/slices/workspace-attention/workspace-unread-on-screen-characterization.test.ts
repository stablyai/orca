import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import '../../../../../shared/agent-session/view/structured-agent-session-projection'
import '@/attention/agent-subject-read-actions'

import {
  completeAgentTurn,
  pointerDownInTab,
  ringBell,
  setWindowOnScreen
} from './workspace-unread-characterization-driver'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  observe,
  WS_A
} from './workspace-unread-characterization-fixture'

// On screen means read, the flag follows its markers, and reads retire OS notifications.

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

let dismiss: ReturnType<typeof installAttentionMockApi>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  dismiss = installAttentionMockApi()
})

afterEach(() => {
  vi.useRealTimers()
})

const dismissedPaneKeys = (): string[][] =>
  dismiss.mock.calls.map((call) => [...(call[1] ?? [])].sort())

describe('on screen means read', () => {
  it('clears the workspace dot when returning input reads a completed agent on the same tab', async () => {
    const { store } = createAttentionStore({ desktopAway: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    store.setState({
      agentStatusByPaneKey: {
        [pane.paneKey]: {
          state: 'done',
          prompt: 'Fix the sidebar',
          updatedAt: 900,
          stateStartedAt: 900,
          stateHistory: [],
          agentType: 'claude',
          ...pane
        }
      }
    })
    completeAgentTurn(store, pane)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().worktreesByRepo.repo1![0]!.isUnread).toBe(true)

    pointerDownInTab(store, pane)

    expect(store.getState().unreadAgentCompletionPanes).toEqual({})
    expect(store.getState().worktreesByRepo.repo1![0]!.isUnread).toBe(false)
  })

  it('a bell on screen waits while the window is unfocused and is read when focus returns', () => {
    const { store, persists } = createAttentionStore({ windowOnScreen: false })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
    expect(dismiss).not.toHaveBeenCalled()

    setWindowOnScreen(store, true)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
    expect(dismissedPaneKeys()).toEqual([[pane.paneKey]])
  })
})
