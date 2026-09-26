// A pane moved out of its spawn tab keeps its leaf id, but the PTY's env keeps
// the tab id it was minted against. When that spawn tab is later closed, a
// reveal carrying the stale tab id re-mints it (STA-7961).
import { describe, expect, it, vi } from 'vitest'
import { addSplitLeafToLayout } from './ipc-events/terminal-command-state'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import { resolveTerminalTabPtyOwnership } from '@/lib/terminal-tab-for-pty-id'
import type { AppState } from '@/store/types'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

const WORKTREE_ID = 'repo1::/repo1'
const SPAWN_TAB_ID = 'tab-x'
const HOST_TAB_ID = 'tab-a'
const MOVED_LEAF_ID = '10cb5648-8a54-41c0-a6a4-ef0028d93599'
const SIBLING_LEAF_ID = '08d0d524-0d46-410b-ba08-b43c97a2b4e4'
const HOST_LEAF_ID = 'df8913c9-fd8a-420a-a7d6-17daf0ed30f0'
const MOVED_PTY_ID = 'repo1::/repo1@@289ed0f2'

type MovedPaneState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
> & { spawnTabPtyIdAfterMove: string | null | undefined }

/** The harness models a layout as an optional root; a rootless snapshot has none. */
function toHarnessLayouts(
  layouts: AppState['terminalLayoutsByTabId']
): HarnessStoreState['terminalLayoutsByTabId'] {
  return Object.fromEntries(
    Object.entries(layouts).map(([tabId, layout]) => [
      tabId,
      {
        ...(layout.root ? { root: layout.root } : {}),
        ...(layout.ptyIdsByLeafId ? { ptyIdsByLeafId: layout.ptyIdsByLeafId } : {})
      }
    ])
  )
}

/**
 * Runs the real move and close through the store: the pane leaves tab X for
 * tab A's split, then the emptied tab X is closed.
 */
function moveThenCloseSpawnTab(): MovedPaneState {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/repo1' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: SPAWN_TAB_ID, worktreeId: WORKTREE_ID, ptyId: MOVED_PTY_ID }),
        makeTab({ id: HOST_TAB_ID, worktreeId: WORKTREE_ID, ptyId: 'pty-host', sortOrder: 1 })
      ]
    },
    ptyIdsByTabId: {
      [SPAWN_TAB_ID]: [MOVED_PTY_ID, 'pty-sibling'],
      [HOST_TAB_ID]: ['pty-host']
    }
  })
  store.getState().setTabLayout(SPAWN_TAB_ID, {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: MOVED_LEAF_ID },
      second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
    },
    activeLeafId: MOVED_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [MOVED_LEAF_ID]: MOVED_PTY_ID, [SIBLING_LEAF_ID]: 'pty-sibling' }
  })
  store.getState().setTabLayout(HOST_TAB_ID, {
    root: { type: 'leaf', leafId: HOST_LEAF_ID },
    activeLeafId: HOST_LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [HOST_LEAF_ID]: 'pty-host' }
  })

  const detached = detachTerminalLayoutLeaf(
    store.getState().terminalLayoutsByTabId[SPAWN_TAB_ID],
    MOVED_LEAF_ID
  )
  if (!detached) {
    throw new Error('Expected the pane to detach from its spawn tab')
  }
  store.getState().setTabLayout(SPAWN_TAB_ID, detached.sourceLayout)
  store
    .getState()
    .setTabLayout(
      HOST_TAB_ID,
      addSplitLeafToLayout(
        store.getState().terminalLayoutsByTabId[HOST_TAB_ID],
        HOST_LEAF_ID,
        MOVED_LEAF_ID,
        MOVED_PTY_ID,
        'horizontal',
        'OpenCode',
        true
      )
    )
  store.getState().syncPaneDetachPtyOwnership({
    detachedLeafId: MOVED_LEAF_ID,
    detachedPtyId: MOVED_PTY_ID,
    sourceLayout: detached.sourceLayout,
    sourceTabId: SPAWN_TAB_ID,
    targetTabId: HOST_TAB_ID
  })

  const spawnTabPtyIdAfterMove = (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).find(
    (tab) => tab.id === SPAWN_TAB_ID
  )?.ptyId

  store.getState().closeTab(SPAWN_TAB_ID, { reason: 'user' })

  const after = store.getState()
  return {
    tabsByWorktree: after.tabsByWorktree,
    ptyIdsByTabId: after.ptyIdsByTabId,
    terminalLayoutsByTabId: after.terminalLayoutsByTabId,
    spawnTabPtyIdAfterMove
  }
}

function tabsBindingMovedLeaf(state: HarnessStoreState): string[] {
  return Object.entries(state.terminalLayoutsByTabId)
    .filter(([, layout]) => MOVED_LEAF_ID in (layout.ptyIdsByLeafId ?? {}))
    .map(([tabId]) => tabId)
}

describe('terminal reveal against a closed spawn tab (STA-7961)', () => {
  it('drops the spawn tab pty id when the pane moves to another tab', () => {
    // Recorded for the report: the move rewrites tab X's own ptyId.
    expect(moveThenCloseSpawnTab().spawnTabPtyIdAfterMove).toBe('pty-sibling')
  })

  it('resolves the pty to the tab the pane moved into, not the stale hint', () => {
    const moved = moveThenCloseSpawnTab()
    expect(
      resolveTerminalTabPtyOwnership(
        {
          tabsByWorktree: moved.tabsByWorktree,
          terminalLayoutsByTabId: moved.terminalLayoutsByTabId,
          ptyIdsByTabId: moved.ptyIdsByTabId
        },
        WORKTREE_ID,
        MOVED_PTY_ID,
        { preferTabId: SPAWN_TAB_ID }
      )
    ).toEqual({ kind: 'owned', tabId: HOST_TAB_ID })
  })

  it('does not resurrect the closed spawn tab or duplicate its leaf id', async () => {
    const moved = moveThenCloseSpawnTab()
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: moved.tabsByWorktree,
      ptyIdsByTabId: moved.ptyIdsByTabId,
      terminalLayoutsByTabId: toHarnessLayouts(moved.terminalLayoutsByTabId),
      createTab: vi.fn((_worktreeId, _groupId, _shell, options) => ({
        id: options?.id ?? 'tab-minted'
      }))
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: WORKTREE_ID,
      ptyId: MOVED_PTY_ID,
      leafId: MOVED_LEAF_ID,
      tabId: SPAWN_TAB_ID,
      presentation: 'focused',
      title: 'OpenCode'
    })

    expect(Object.keys(storeState.terminalLayoutsByTabId)).not.toContain(SPAWN_TAB_ID)
    expect(tabsBindingMovedLeaf(storeState)).toEqual([HOST_TAB_ID])
  })

  it('still adopts the host tab when the reveal beats layout hydration', async () => {
    // Nothing is hydrated except the tab rows, so the host tab's own ptyId is
    // the last binding standing. It is enough, and the stale hint loses.
    const moved = moveThenCloseSpawnTab()
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: moved.tabsByWorktree,
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      createTab: vi.fn((_worktreeId, _groupId, _shell, options) => ({
        id: options?.id ?? 'tab-minted'
      }))
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: WORKTREE_ID,
      ptyId: MOVED_PTY_ID,
      leafId: MOVED_LEAF_ID,
      tabId: SPAWN_TAB_ID,
      presentation: 'focused',
      title: 'OpenCode'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(tabsBindingMovedLeaf(storeState)).toEqual([HOST_TAB_ID])
  })

  it('fails the reveal instead of minting when the only owner has no tab row', async () => {
    // A layout can outlive its row. Nothing is left to activate, and minting
    // here would re-bind a leaf id the orphan layout still holds (STA-7961).
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-gone': { ptyIdsByLeafId: { [MOVED_LEAF_ID]: MOVED_PTY_ID } }
      },
      createTab: vi.fn((_worktreeId, _groupId, _shell, options) => ({
        id: options?.id ?? 'tab-minted'
      }))
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: WORKTREE_ID,
      ptyId: MOVED_PTY_ID,
      leafId: MOVED_LEAF_ID,
      presentation: 'focused',
      title: 'OpenCode'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(tabsBindingMovedLeaf(storeState)).toEqual(['tab-gone'])
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'reveal',
      error: 'terminal_reveal_owner_row_missing: tab tab-gone'
    })
  })

  it('keeps the closed spawn tab retired when the host tab row is out of scope', async () => {
    // Same move and close, but the reveal names a worktree whose tab list does
    // not carry the host row. The stale hint becomes the minted tab's id.
    const moved = moveThenCloseSpawnTab()
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: toHarnessLayouts(moved.terminalLayoutsByTabId),
      createTab: vi.fn((_worktreeId, _groupId, _shell, options) => ({
        id: options?.id ?? 'tab-minted'
      }))
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: WORKTREE_ID,
      ptyId: MOVED_PTY_ID,
      leafId: MOVED_LEAF_ID,
      tabId: SPAWN_TAB_ID,
      presentation: 'focused',
      title: 'OpenCode'
    })

    expect(Object.keys(storeState.terminalLayoutsByTabId)).not.toContain(SPAWN_TAB_ID)
    expect(tabsBindingMovedLeaf(storeState)).toEqual([HOST_TAB_ID])
  })
})
