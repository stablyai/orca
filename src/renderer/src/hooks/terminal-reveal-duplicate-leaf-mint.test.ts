import { describe, expect, it } from 'vitest'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'

const WORKTREE_ID = 'wt-1'
const SHARED_LEAF_ID = 'leaf-shared'
const SHARED_PTY_ID = 'pty-shared'

/** Tabs whose persisted layout binds SHARED_LEAF_ID, whatever pty it points at. */
function tabsBindingSharedLeaf(state: HarnessStoreState): string[] {
  return Object.entries(state.terminalLayoutsByTabId)
    .filter(([, layout]) => SHARED_LEAF_ID in (layout.ptyIdsByLeafId ?? {}))
    .map(([tabId]) => tabId)
}

function revealUnownedPty(harness: {
  createTerminal: (request: {
    requestId?: string
    worktreeId: string
    ptyId?: string
    leafId?: string
    presentation?: 'background' | 'focused'
    title?: string
  }) => void
}): void {
  harness.createTerminal({
    requestId: 'reveal',
    worktreeId: WORKTREE_ID,
    ptyId: SHARED_PTY_ID,
    leafId: SHARED_LEAF_ID,
    presentation: 'focused',
    title: 'OpenCode'
  })
}

describe('terminal reveal must not mint a tab that reuses a bound leaf id (STA-7961)', () => {
  it('leaves the leaf id bound to one tab when the owning row is filed under another workspace key', async () => {
    // terminalLayoutsByTabId is keyed by tab id alone, so it still records
    // tab-a's split leaf while the reveal's worktree key lists other rows.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-other', ptyId: 'pty-other', title: 'Terminal 3' }],
        'wt-other': [{ id: 'tab-a', ptyId: 'pty-a', title: 'Terminal 1' }]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-a': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', [SHARED_LEAF_ID]: SHARED_PTY_ID } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealUnownedPty(harness)

    expect(tabsBindingSharedLeaf(storeState)).toEqual(['tab-a'])
  })

  it('refuses to bind a leaf id a sibling tab in the same worktree already owns', async () => {
    // The pty is unowned, so ownership resolves to none; the leaf id is not,
    // and re-minting it hands two tabs the same pane identity.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-a', ptyId: 'pty-a', title: 'Terminal 1' }]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-a': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', [SHARED_LEAF_ID]: 'pty-stale' } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealUnownedPty(harness)

    expect(tabsBindingSharedLeaf(storeState)).toEqual(['tab-a'])
  })

  it('adopts the recorded owner instead of minting when the layout binds the pty but no pane is mounted', async () => {
    // Control for the hibernated-pane hypothesis: a recorded layout row alone
    // is enough for the resolver, so this path never reaches the mint branch.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-a', ptyId: 'pty-a', title: 'Terminal 1' }]
      },
      ptyIdsByTabId: { 'tab-a': [] },
      terminalLayoutsByTabId: {
        'tab-a': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', [SHARED_LEAF_ID]: SHARED_PTY_ID } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealUnownedPty(harness)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(tabsBindingSharedLeaf(storeState)).toEqual(['tab-a'])
  })
})
