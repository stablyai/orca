// Real-store coverage: the floating New Terminal ("+" menu and Cmd+T) selects its tab in the floating panel only.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})
const focusTerminalTabSurface = vi.hoisted(() => vi.fn())

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, useCallback: <T>(callback: T) => callback }
})

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface }))

createStoreCascadesMockApi()

const MAIN_WORKTREE_ID = 'repo1::/path/wt1'

describe('floating "+" New Terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selects the new tab in the floating panel without moving the main window', async () => {
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
    store.getState().setActiveTabType('editor', MAIN_WORKTREE_ID)
    const previousFloatingTab = store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)
    const { useFloatingTerminalCreateActions } =
      await import('./use-floating-terminal-create-actions')
    const seeded = store.getState()
    const floatingGroup = seeded.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(floatingGroup?.activeTabId).toBe(previousFloatingTab.id)

    const { createFloatingTerminalTab } = useFloatingTerminalCreateActions({
      activateTab: seeded.activateTab,
      setActiveTab: seeded.setActiveTab,
      createBrowserTab: seeded.createBrowserTab,
      browserDefaultUrl: seeded.browserDefaultUrl,
      openFile: seeded.openFile,
      activeGroup: floatingGroup,
      groupTabs: seeded.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? [],
      markdownCwd: null
    })
    createFloatingTerminalTab()

    const state = store.getState()
    const newTab = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.find(
      (tab) => tab.id !== previousFloatingTab.id
    )
    expect(newTab).toBeDefined()
    expect(state.activeTabId).toBe(mainTerminal.id)
    expect(state.activeTabType).toBe('editor')
    expect(state.activeTabTypeByWorktree[MAIN_WORKTREE_ID]).toBe('editor')
    expect(state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]?.activeTabId).toBe(newTab?.id)
    // Why: auto-acknowledge reads this map; it must follow the tab the floating panel shows.
    expect(state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(newTab?.id)
    expect(focusTerminalTabSurface).toHaveBeenCalledExactlyOnceWith(newTab?.id)
  })
})
