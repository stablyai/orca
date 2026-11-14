import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {},
  activateTabAndFocusPane: vi.fn(),
  refreshSnapshot: vi.fn()
}))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../../../lib/workspace/tabs/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  matchesWebSessionIntentOwner: () => true
}))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refreshSnapshot
}))

import {
  beginWebRuntimeSplitFocusRequest,
  captureWebRuntimeSplitFocusTarget,
  focusSplitWebRuntimeTerminalPane
} from './web-runtime-split-focus'

const OWNER = { environmentId: 'env-1', pairingRevision: 1 }
const SOURCE_PTY = 'remote:env-1@@term-1'
const SPLIT = { handle: 'term-2', tabId: 'tab-1', paneRuntimeId: -1, leafId: 'leaf-2' }

function setActiveLeaf(leafId: string): void {
  mocks.state = {
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: null,
    tabsByWorktree: { 'wt-1': [{ id: 'web-terminal-tab-1' }] },
    groupsByWorktree: { 'wt-1': [{ id: 'group-1', activeTabId: 'web-terminal-tab-1' }] },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    unifiedTabsByWorktree: { 'wt-1': [{ id: 'web-terminal-tab-1', groupId: 'group-1' }] },
    terminalLayoutsByTabId: {
      'web-terminal-tab-1': {
        activeLeafId: leafId,
        ptyIdsByLeafId: { 'leaf-1': SOURCE_PTY, 'leaf-2': 'remote:env-1@@term-2' }
      }
    }
  }
}

describe('focusSplitWebRuntimeTerminalPane', () => {
  it('focuses the new pane when the replayed snapshot already made it active', async () => {
    setActiveLeaf('leaf-1')
    const target = captureWebRuntimeSplitFocusTarget(SOURCE_PTY, {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'leaf-1'
    })
    mocks.refreshSnapshot.mockImplementationOnce(async () => setActiveLeaf('leaf-2'))

    await focusSplitWebRuntimeTerminalPane(
      OWNER,
      target,
      beginWebRuntimeSplitFocusRequest(OWNER, 'wt-1'),
      SPLIT
    )

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('web-terminal-tab-1', 'leaf-2')
  })
})
