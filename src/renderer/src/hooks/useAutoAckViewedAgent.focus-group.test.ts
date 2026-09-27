// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentAutoAckPresence from './agent-auto-ack-presence'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { makeTab, makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

vi.mock('./agent-auto-ack-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentAutoAckPresence>()),
  createAutoAckPresenceCheck: (_read: unknown, onPresent: () => void) => ({
    request: onPresent,
    dispose() {}
  })
}))

const WORKSPACE = 'focus-group-workspace'
const TERMINAL_GROUP = 'terminal-group'
const CHAT_GROUP = 'chat-group'
const TERMINAL_TAB = 'terminal-tab'
const CHAT_TAB = 'chat-tab'
const CHAT_SESSION = 'chat-session'
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, CHAT_SESSION)

describe('useAutoAckViewedAgent focus-group transitions', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useAppStore.setState({
      activeView: 'terminal',
      activeWorktreeId: WORKSPACE,
      activeTabId: TERMINAL_TAB,
      activeTabIdByWorktree: { [WORKSPACE]: TERMINAL_TAB },
      activeGroupIdByWorktree: { [WORKSPACE]: TERMINAL_GROUP },
      activeTabType: 'terminal',
      tabsByWorktree: { [WORKSPACE]: [makeTab({ id: TERMINAL_TAB, worktreeId: WORKSPACE })] },
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          makeUnifiedTab({
            id: TERMINAL_TAB,
            worktreeId: WORKSPACE,
            groupId: TERMINAL_GROUP
          }),
          makeUnifiedTab({
            id: CHAT_TAB,
            worktreeId: WORKSPACE,
            groupId: CHAT_GROUP,
            contentType: 'agent-session',
            entityId: CHAT_SESSION,
            agentSessionAgent: 'claude'
          })
        ]
      },
      groupsByWorktree: {
        [WORKSPACE]: [
          makeTabGroup({
            id: TERMINAL_GROUP,
            worktreeId: WORKSPACE,
            activeTabId: TERMINAL_TAB,
            tabOrder: [TERMINAL_TAB]
          }),
          makeTabGroup({
            id: CHAT_GROUP,
            worktreeId: WORKSPACE,
            activeTabId: CHAT_TAB,
            tabOrder: [CHAT_TAB]
          })
        ]
      },
      unreadAgentCompletionPanes: { [CHAT_SUBJECT]: 'agent-completion' },
      unreadTerminalTabs: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      acknowledgedAgentsByPaneKey: {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('rescans when focusing a group whose structured tab becomes visible', () => {
    renderHook(() => useAutoAckViewedAgent(false))
    expect(useAppStore.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBe('agent-completion')

    act(() => {
      useAppStore.getState().focusGroup(WORKSPACE, CHAT_GROUP)
    })

    expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe(CHAT_GROUP)
    expect(useAppStore.getState().unreadAgentCompletionPanes[CHAT_SUBJECT]).toBeUndefined()
  })
})
