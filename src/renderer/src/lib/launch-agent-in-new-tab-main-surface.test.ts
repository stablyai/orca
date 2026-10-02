// Real-store coverage: a launch into the floating workspace must leave the main window's tab alone.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

createStoreCascadesMockApi()

const MAIN_WORKTREE_ID = 'repo1::/path/wt1'

function seedMainWindowOnEditor(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: {
      repo1: [makeWorktree({ id: MAIN_WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: MAIN_WORKTREE_ID
  })
  const mainTerminal = store.getState().createTab(MAIN_WORKTREE_ID)
  // The main window is showing a non-terminal tab, as in the report.
  store.getState().setActiveTabType('editor', MAIN_WORKTREE_ID)
  expect(store.getState().activeTabId).toBe(mainTerminal.id)
  return store
}

describe('launchAgentInNewTab main-window surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selects a floating launch in the floating panel without moving the main window', async () => {
    const store = seedMainWindowOnEditor()
    const before = store.getState()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'opencode',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    expect(result?.surface.kind).toBe('local-terminal')
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : null
    const state = store.getState()
    expect(state.activeTabType).toBe('editor')
    expect(state.activeTabId).toBe(before.activeTabId)
    expect(state.activeTabTypeByWorktree[MAIN_WORKTREE_ID]).toBe('editor')
    // Why: the floating panel renders the group's active tab, so the launch still lands selected there.
    const floatingGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(floatingGroup?.activeTabId).toBe(tabId)
    expect(state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(tabId)
    expect(state.activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('terminal')
  })

  it('still brings a launch in the active worktree to the front', async () => {
    const store = seedMainWindowOnEditor()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'opencode', worktreeId: MAIN_WORKTREE_ID })

    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : null
    expect(tabId).not.toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeTabId).toBe(tabId)
  })
})
