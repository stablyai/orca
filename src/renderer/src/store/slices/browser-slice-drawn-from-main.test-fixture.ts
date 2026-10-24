// The browser slice's partial test store with main drawing its tabs in a layout-owner build.

import { onTestFinished } from 'vitest'
import type { AppState } from '../types'
import { createTabsGroupActions } from './tabs/tabs-group-actions'
import { createTestStore } from './browser-slice-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

export type BrowserTestStore = ReturnType<typeof createTestStore>

/** A worktree's one empty pane group, which main places an open in; it replaces wt-1's. */
export function onePaneGroup(worktreeId: string, groupId = 'group-1'): Partial<AppState> {
  return {
    groupsByWorktree: {
      [worktreeId]: [{ id: groupId, worktreeId, activeTabId: null, tabOrder: [] }]
    },
    layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId } },
    activeGroupIdByWorktree: { [worktreeId]: groupId }
  }
}

/** wt-1's pane group, plus the slices a session payload reads that the partial store lacks. */
const DRAWN_STORE_SEED: Partial<AppState> = {
  repos: [],
  editorDrafts: {},
  markdownFrontmatterVisible: {},
  activeFileIdByWorktree: {},
  workspaceDocHistory: [],
  lastVisitedAtByWorktreeId: {},
  defaultTerminalTabsAppliedByWorktreeId: {},
  ...onePaneGroup('wt-1')
}

/**
 * The partial store with main drawing its tabs (switch-on): seeded first, since main loads the
 * layout the store holds now. The test file installs the layout-apply transport (see
 * tabs-drawn-from-main.test-fixture.ts); main closes when the test finishes.
 */
export async function createTestStoreDrawnFromMain(
  seed?: Partial<AppState>
): Promise<{ store: BrowserTestStore; main: TabsDrawnFromMain }> {
  const store = createTestStore()
  // Main drops a workspace with its last tab; the next open places through the real root group.
  const { ensureWorktreeRootGroup, focusGroup } = createTabsGroupActions(
    store.setState,
    store.getState
  )
  store.setState({ ...DRAWN_STORE_SEED, ensureWorktreeRootGroup, focusGroup, ...seed })
  const main = await drawTabsFromMain(store)
  onTestFinished(() => main.close())
  return { store, main }
}
