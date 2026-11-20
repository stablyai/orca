import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeTerminalTab } from '@/store/terminals/testing/terminal-row.test-fixture'
import { isDetachedRestartInFlight } from '@/components/terminal-pane/account-restart/detached/codex-detached-pane-restart'
import { notifyDetachedRestartSettled } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import { trackManualAgentRestarts } from './manual-agent-restart-outcome'

vi.mock('@/components/terminal-pane/account-restart/detached/codex-detached-pane-restart', () => ({
  isDetachedRestartInFlight: vi.fn(() => false)
}))

const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const LEAF_ID = '0195f2ce-1111-4000-8000-000000000001'
const PANE = { tabId: TAB_ID, leafId: LEAF_ID, ptyId: 'pty-1' }
const initialState = useAppStore.getState()

function leafLayout(ptyIdsByLeafId: Record<string, string>) {
  return {
    root: { type: 'leaf' as const, leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function seedQueuedPane(): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: 'pty-1' })]
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    terminalLayoutsByTabId: { [TAB_ID]: leafLayout({ [LEAF_ID]: 'pty-1' }) }
  })
  useAppStore.getState().queuePaneManualRestarts([{ ptyId: 'pty-1', agent: 'codex' }])
}

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.mocked(isDetachedRestartInFlight).mockReset().mockReturnValue(false)
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

it('counts a mounted pane that binds a new PTY after its binding was cleared as restarted', async () => {
  seedQueuedPane()
  const outcome = trackManualAgentRestarts([PANE])

  // The mounted executor consumes and clears the binding in one tick; the new PTY binds later.
  useAppStore.getState().consumePendingPaneRestart('pty-1')
  useAppStore.getState().setTabLayout(TAB_ID, leafLayout({}))
  await Promise.resolve()
  useAppStore.getState().setTabLayout(TAB_ID, leafLayout({ [LEAF_ID]: 'pty-3' }))

  expect(await outcome).toEqual({ restarted: 1, failed: 0 })
})

it('waits for an in-flight detached restart to rebind the leaf', async () => {
  seedQueuedPane()
  vi.mocked(isDetachedRestartInFlight).mockImplementation((ptyId) => ptyId === 'pty-1')
  const outcome = trackManualAgentRestarts([PANE])

  useAppStore.getState().consumePendingPaneRestart('pty-1')
  await Promise.resolve()
  useAppStore.getState().updateTabPtyId(TAB_ID, 'pty-3', 'pty-1')

  expect(await outcome).toEqual({ restarted: 1, failed: 0 })
})

it('keeps waiting when a detached claim hands its restart back to the mounted pane', async () => {
  seedQueuedPane()
  vi.mocked(isDetachedRestartInFlight).mockReturnValue(true)
  const outcome = trackManualAgentRestarts([PANE])

  useAppStore.getState().consumePendingPaneRestart('pty-1')
  await Promise.resolve()
  useAppStore.getState().queuePaneManualRestarts([{ ptyId: 'pty-1', agent: 'codex' }])
  vi.mocked(isDetachedRestartInFlight).mockReturnValue(false)
  notifyDetachedRestartSettled()
  await Promise.resolve()
  // The mounted executor then consumes the handed-back entry and binds the new PTY.
  useAppStore.getState().consumePendingPaneRestart('pty-1')
  useAppStore.getState().updateTabPtyId(TAB_ID, 'pty-3', 'pty-1')

  expect(await outcome).toEqual({ restarted: 1, failed: 0 })
})
