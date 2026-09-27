// A split reveal names its parent tab by id, but that row can sit under a worktree key other
// than the event's (STA-7961). Looking the hint up in the event worktree's list alone failed the
// whole reveal, so the split pane never appeared.
import { describe, expect, it } from 'vitest'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import {
  resolveTerminalRevealTabAdoption,
  type TerminalRevealAdoptionState
} from '@/lib/terminal-reveal-tab-adoption'
import {
  createStoreWithOwnerFiledElsewhere,
  loadIpcEventsHarness,
  OWNER_ELSEWHERE_EVENT_WORKTREE_ID as EVENT_WORKTREE_ID,
  OWNER_ELSEWHERE_OWNER_WORKTREE_ID as OWNER_WORKTREE_ID,
  type HarnessStoreState
} from './ipc-events-test-harness'
import { makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'

/** The owner tab is also mounted here, so the split adopts a pty with a live pane. */
function storeWithMountedOwnerFiledElsewhere(): HarnessStoreState {
  return createStoreWithOwnerFiledElsewhere({ ptyIdsByTabId: { 'tab-a': ['pty-a'] } })
}

describe('split reveal whose target tab is filed under another worktree key', () => {
  it('splits the owner tab instead of failing the reveal', async () => {
    const storeState = storeWithMountedOwnerFiledElsewhere()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: EVENT_WORKTREE_ID,
      ptyId: 'pty-split',
      tabId: 'tab-a',
      leafId: 'leaf-split',
      splitFromLeafId: 'leaf-a',
      presentation: 'focused'
    })

    const reply = harness.replyTerminalCreate.mock.calls[0]?.[0]
    expect(reply).toMatchObject({ requestId: 'reveal', tabId: 'tab-a' })
    expect(reply.error).toBeUndefined()
    expect(storeState.createTab).not.toHaveBeenCalled()
    const layout = storeState.terminalLayoutsByTabId['tab-a']
    expect(collectLeafIdsInOrder(layout.root ?? null)).toEqual(['leaf-a', 'leaf-split'])
    expect(layout.ptyIdsByLeafId).toMatchObject({ 'leaf-split': 'pty-split' })
  })

  it('adopts the hinted parent as the owner of a brand-new split pty', () => {
    // Why this is asserted on its own: it is what lets the split path reuse the adopted row
    // instead of looking the hint up a second time.
    const state: TerminalRevealAdoptionState = {
      tabsByWorktree: {
        [OWNER_WORKTREE_ID]: [makeTerminalTab({ id: 'tab-a', worktreeId: OWNER_WORKTREE_ID })]
      },
      terminalLayoutsByTabId: {
        'tab-a': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
        }
      },
      ptyIdsByTabId: {}
    }

    expect(
      resolveTerminalRevealTabAdoption(state, { ptyId: 'pty-split', hintTabId: 'tab-a' })
    ).toBe('tab-a')
  })

  it('still fails a split reveal whose parent row exists under no worktree key', async () => {
    const storeState = storeWithMountedOwnerFiledElsewhere()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'reveal',
      worktreeId: EVENT_WORKTREE_ID,
      ptyId: 'pty-split',
      tabId: 'tab-gone',
      leafId: 'leaf-split',
      splitFromLeafId: 'leaf-a',
      presentation: 'focused'
    })

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'reveal',
      error: 'Terminal tab tab-gone not found'
    })
  })
})
