// A split reveal names its parent tab by id, but that row can sit under a worktree key other
// than the event's (STA-7961). Looking the hint up in the event worktree's list alone failed the
// whole reveal, so the split pane never appeared.
import { describe, expect, it } from 'vitest'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'

const EVENT_WORKTREE_ID = 'wt-1'
const OWNER_WORKTREE_ID = 'wt-other'

function storeWithOwnerFiledElsewhere(): HarnessStoreState {
  return createHarnessStoreState({
    tabsByWorktree: {
      [EVENT_WORKTREE_ID]: [{ id: 'tab-other', ptyId: 'pty-other', title: 'Terminal 3' }],
      [OWNER_WORKTREE_ID]: [{ id: 'tab-a', ptyId: 'pty-a', title: 'Terminal 1' }]
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'] },
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
      }
    }
  })
}

describe('split reveal whose target tab is filed under another worktree key', () => {
  it('splits the owner tab instead of failing the reveal', async () => {
    const storeState = storeWithOwnerFiledElsewhere()
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
})
