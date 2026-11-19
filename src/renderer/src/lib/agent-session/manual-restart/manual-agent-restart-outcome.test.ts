import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeTerminalTab } from '@/store/terminals/testing/terminal-row.test-fixture'
import { trackManualAgentRestarts } from './manual-agent-restart-outcome'

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const PANE = { tabId: TAB_ID, leafId: LEAF_ID, ptyId: 'pty-1' }
const initialState = useAppStore.getState()

function seedQueuedPane(): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: 'pty-1' })]
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    }
  })
  useAppStore.getState().queuePaneManualRestarts([{ ptyId: 'pty-1', agent: 'codex' }])
}

afterEach(() => {
  useAppStore.setState(initialState, true)
})

it('does not count a reattach rotation as a restart', async () => {
  seedQueuedPane()
  const outcome = trackManualAgentRestarts([PANE])

  // The detached sweep can consume the moved entry before a deferred check runs.
  useAppStore.getState().updateTabPtyId(TAB_ID, 'pty-2', 'pty-1')
  useAppStore.getState().consumePendingPaneRestart('pty-2')

  expect(await outcome).toEqual({ restarted: 0, failed: 1 })
})

it('counts a mounted pane whose binding survives consumption as failed', async () => {
  seedQueuedPane()
  const outcome = trackManualAgentRestarts([PANE])

  useAppStore.getState().consumePendingPaneRestart('pty-1')

  expect(await outcome).toEqual({ restarted: 0, failed: 1 })
})

it('counts a closed tab as failed without throwing', async () => {
  seedQueuedPane()
  const outcome = trackManualAgentRestarts([PANE])

  useAppStore.setState({
    tabsByWorktree: { [WORKTREE_ID]: [] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {}
  })

  expect(await outcome).toEqual({ restarted: 0, failed: 1 })
})
