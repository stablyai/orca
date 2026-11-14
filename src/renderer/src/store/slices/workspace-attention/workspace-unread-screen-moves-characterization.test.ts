import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import '../../../../../shared/workspace-scope'
import { pointerDownInTab, ringBell } from './workspace-unread-characterization-driver'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  observe,
  WS_A
} from './workspace-unread-characterization-fixture'

// What counts as the screen moving, what is on it, and who is looking at it.

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  installAttentionMockApi()
})

afterEach(() => {
  vi.useRealTimers()
})

const flushPresenceCheck = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('presence', () => {
  it('a bell on screen while the desktop is away marks, and returning input reads it', async () => {
    const { store, persists } = createAttentionStore({ desktopAway: true })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    await flushPresenceCheck()
    observe(store, persists)

    ringBell(store, pane)
    await flushPresenceCheck()
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

    pointerDownInTab(store, { ...pane, paneKey: null })
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
  })
})

describe('presence evidence', () => {
  it('main saying not away does not count as presence for a later bell', async () => {
    let away = false
    const { store, persists } = createAttentionStore({ desktopAway: () => away })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', isUnread: true })]
      }
    })
    store.getState().setActiveWorktree(WS_A)
    await flushPresenceCheck()
    // Main answered "not away" for this arrival, so the restart flag was read.
    expect(observe(store, persists)[0]).toContain('a@local:read')

    // Why 100s, not 200s: stamping main's answer as presence would wrongly cover only < 180s.
    away = true
    vi.setSystemTime(101_000)
    ringBell(store, pane)
    await flushPresenceCheck()
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:101000 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":101000}",
      ]
    `)
  })
})
