import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { makeFolderWorkspace } from '../worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import '../../../../../shared/constants'
import {
  addLiveTerminalTab,
  createAttentionStore,
  installAttentionMockApi,
  observe,
  WS_A
} from './workspace-unread-characterization-fixture'
import { pointerDownInTab, ringBell, typeInPane } from './workspace-unread-characterization-driver'

// Pin marker/flag persistence, activity, Dock and floating-dot transitions using the production scan; default window is visible/focused.

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

describe('hot-path no-ops keep the store reference', () => {
  it('a keystroke on a read workspace and a repeat bell notify nobody', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    store.setState({ folderWorkspaces: [makeFolderWorkspace()] })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const folderPane = addLiveTerminalTab(store, folderWorkspaceKey('folder-1'), 'tab-f1')
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })
    const before = store.getState()

    for (let i = 0; i < 50; i += 1) {
      typeInPane(store, pane)
      typeInPane(store, folderPane)
      pointerDownInTab(store, { ...pane, paneKey: null })
    }
    expect(notifications).toBe(0)
    expect(store.getState()).toBe(before)

    ringBell(store, pane)
    const lit = store.getState()
    notifications = 0
    ringBell(store, pane)
    expect(notifications).toBe(0)
    expect(store.getState()).toBe(lit)
    unsubscribe()
    observe(store, persists)
  })
})
