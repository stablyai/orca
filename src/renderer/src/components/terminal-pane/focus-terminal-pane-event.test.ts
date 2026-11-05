// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'

const CHAT = '11111111-1111-4111-8111-111111111111'
const SHELL_B = '22222222-2222-4222-8222-222222222222'
const SHELL_C = '33333333-3333-4333-8333-333333333333'

describe('handleFocusTerminalPaneDetail', () => {
  // Add to chat reveals a chat leaf; an expanded shell would keep it hidden even when it isn't the active pane.
  it('collapses the expanded pane, not the active one, before focusing the target', () => {
    const leaves = [CHAT, SHELL_B, SHELL_C]
    const manager = {
      getNumericIdForLeaf: (leafId: string) => leaves.indexOf(leafId) + 1 || null,
      getPanes: () =>
        leaves.map((leafId, index) => ({ id: index + 1, leafId, container: document.body })),
      setActivePane: vi.fn()
    }
    const toggleExpandPane = vi.fn()
    handleFocusTerminalPaneDetail(
      { tabId: 'tab', leafId: CHAT, collapseExpandedPane: true },
      {
        tabId: 'tab',
        manager,
        acknowledgeAgents: vi.fn(),
        surfaceStaleAgentRow: vi.fn(),
        expandedLeafId: SHELL_B,
        toggleExpandPane
      }
    )
    expect(toggleExpandPane).toHaveBeenCalledWith(2)
    expect(manager.setActivePane).toHaveBeenCalledWith(1, { focus: true })
  })
})
