// A reveal that mints a tab for a leaf id some layout already holds hands two panes one pane
// identity, and the renderer delivers PTY data to one handler slot per pty id — so one pane
// starves and both fight over the grid size. That is STA-7961.
import { describe, expect, it } from 'vitest'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import {
  createHarnessStoreState,
  createStoreWithOwnerFiledElsewhere,
  loadIpcEventsHarness,
  OWNER_ELSEWHERE_EVENT_WORKTREE_ID as WORKTREE_ID,
  type HarnessStoreState
} from './ipc-events-test-harness'
const SHARED_LEAF_ID = 'leaf-shared'
const SHARED_PTY_ID = 'pty-shared'

/** Tabs whose layout binds SHARED_LEAF_ID, whatever pty it points at. */
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
    // terminalLayoutsByTabId is keyed by tab id alone, so it still records tab-a's
    // split leaf while the reveal's worktree key lists entirely different rows.
    const storeState: HarnessStoreState = createStoreWithOwnerFiledElsewhere({
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

  it('refuses to bind a leaf id a sibling tab in the same worktree already owns', async () => {
    // The pty is unowned, so ownership resolves to none; the leaf id is not, and
    // re-minting it hands two tabs the same pane identity.
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

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(tabsBindingSharedLeaf(storeState)).toEqual(['tab-a'])
  })

  it('adopts the recorded owner instead of minting when the layout binds the pty but no pane is mounted', async () => {
    // Control for the hibernated-pane hypothesis: a recorded layout row alone is
    // enough for the resolver, so this path never reaches the bound-leaf branch.
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

  it('adopts the tab whose layout carries the leaf over the tab the pty was minted against', async () => {
    // The hint is a spawn-time tab id, not a binding. tab-b already holds the leaf, so reusing
    // the hinted tab-a writes a single pane over its split and orphans leaf-a2's pty.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-a', ptyId: 'pty-a1', title: 'Terminal 1' },
          { id: 'tab-b', ptyId: null, title: 'Terminal 2' }
        ]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-a': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-a1' },
            second: { type: 'leaf', leafId: 'leaf-a2' }
          },
          ptyIdsByLeafId: { 'leaf-a1': 'pty-a1', 'leaf-a2': 'pty-a2' }
        },
        // Bound to a dead pty, so the revealed pty is still owned by nobody.
        'tab-b': {
          root: { type: 'leaf', leafId: SHARED_LEAF_ID },
          ptyIdsByLeafId: { [SHARED_LEAF_ID]: 'pty-stale' }
        }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: WORKTREE_ID,
      ptyId: SHARED_PTY_ID,
      tabId: 'tab-a',
      leafId: SHARED_LEAF_ID,
      presentation: 'focused',
      title: 'OpenCode'
    })

    expect(harness.replyTerminalCreate.mock.calls[0]?.[0]).toMatchObject({ tabId: 'tab-b' })
    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(tabsBindingSharedLeaf(storeState)).toEqual(['tab-b'])
    const hintedLayout = storeState.terminalLayoutsByTabId['tab-a']!
    expect(collectLeafIdsInOrder(hintedLayout.root ?? null)).toEqual(['leaf-a1', 'leaf-a2'])
    expect(hintedLayout.ptyIdsByLeafId).toEqual({ 'leaf-a1': 'pty-a1', 'leaf-a2': 'pty-a2' })
  })
})
