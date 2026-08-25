// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '../store'
import { makeTab } from '../store/slices/store-test-helpers'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'

const WORKTREE_ID = 'wt-attention'
const TAB_ID = 'tab-attention'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

describe('useAutoAckViewedAgent recovered attention', () => {
  const acknowledgeAgents = vi.fn()
  const clearWorktreeUnread = vi.fn()

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useAppStore.setState({
      activeView: 'terminal',
      activeTabId: TAB_ID,
      activeWorktreeId: WORKTREE_ID,
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] },
      terminalLayoutsByTabId: {
        [TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      unreadAgentCompletionPanes: {},
      unreadTerminalTabs: {},
      acknowledgeAgents,
      clearWorktreeUnread
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('acks the visible row without clearing unread that has no completion-source marker', () => {
    renderHook(() => useAutoAckViewedAgent(false))

    useAppStore.getState().setAgentStatus(PANE_KEY, {
      state: 'waiting',
      prompt: 'Approve?',
      agentType: 'claude'
    })

    expect(acknowledgeAgents).toHaveBeenCalledWith([PANE_KEY])
    expect(clearWorktreeUnread).not.toHaveBeenCalled()
  })
})
