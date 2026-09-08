// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { selectFloatingWorkspaceHasUnread } from '../store/selectors'
import { makeTab } from '../store/slices/store-test-helpers'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'

const FLOATING_TAB_ID = 'tab-floating'
const MAIN_TAB_ID = 'tab-main'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const MAIN_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const FLOATING_PANE_KEY = makePaneKey(FLOATING_TAB_ID, LEAF_ID)
const MAIN_PANE_KEY = makePaneKey(MAIN_TAB_ID, MAIN_LEAF_ID)

function seedFloatingCompletion(): void {
  useAppStore.setState({
    activeView: 'activity',
    activeTabId: null,
    activeWorktreeId: 'wt-1',
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID },
    tabsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        makeTab({ id: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
      ]
    },
    terminalLayoutsByTabId: {
      [FLOATING_TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
    },
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    acknowledgedAgentsByPaneKey: {}
  })
}

describe('useAutoAckViewedAgent — floating workspace panel visibility', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    seedFloatingCompletion()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the attention dot lit while the panel is closed and clears it once it opens', () => {
    const hook = renderHook(
      ({ floatingPanelVisible }: { floatingPanelVisible: boolean }) =>
        useAutoAckViewedAgent(floatingPanelVisible),
      { initialProps: { floatingPanelVisible: false } }
    )

    // The dot is the only signal a closed panel has, so a store write while hidden must not ack it.
    useAppStore.getState().markAgentCompletionPaneUnread(FLOATING_PANE_KEY)
    expect(selectFloatingWorkspaceHasUnread(useAppStore.getState())).toBe(true)

    hook.rerender({ floatingPanelVisible: true })

    expect(selectFloatingWorkspaceHasUnread(useAppStore.getState())).toBe(false)
  })

  // Why: the only case where the scan acks two targets, and acking the first re-enters the scan
  // synchronously — so this is the path where a stale mid-loop snapshot would surface.
  it('clears both the active terminal tab and the floating tab in one pass', () => {
    useAppStore.setState({
      activeView: 'terminal',
      activeTabId: MAIN_TAB_ID,
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {
        'wt-1': [makeTab({ id: MAIN_TAB_ID, worktreeId: 'wt-1' })],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTab({ id: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
        ]
      },
      terminalLayoutsByTabId: {
        [MAIN_TAB_ID]: { root: null, activeLeafId: MAIN_LEAF_ID, expandedLeafId: null },
        [FLOATING_TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
      }
    })

    const hook = renderHook(
      ({ floatingPanelVisible }: { floatingPanelVisible: boolean }) =>
        useAutoAckViewedAgent(floatingPanelVisible),
      { initialProps: { floatingPanelVisible: false } }
    )

    useAppStore.getState().markAgentCompletionPaneUnread(MAIN_PANE_KEY)
    useAppStore.getState().markAgentCompletionPaneUnread(FLOATING_PANE_KEY)
    expect(selectFloatingWorkspaceHasUnread(useAppStore.getState())).toBe(true)

    hook.rerender({ floatingPanelVisible: true })

    const state = useAppStore.getState()
    expect(state.unreadAgentCompletionPanes[MAIN_PANE_KEY]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[FLOATING_PANE_KEY]).toBeUndefined()
    expect(selectFloatingWorkspaceHasUnread(state)).toBe(false)
  })
})
