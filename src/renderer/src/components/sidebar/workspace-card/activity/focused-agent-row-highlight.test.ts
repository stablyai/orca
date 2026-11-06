import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import { getFocusedAgentPaneKeyForWorktree } from './focused-agent-row-highlight'

const chatTab: Tab = {
  id: 'chat-tab',
  entityId: 'session-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'agent-session',
  agentSessionAgent: 'claude',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
const chatPaneKey = 'chat-tab:84097828-fc31-48c8-a292-10df48901a85'

describe('getFocusedAgentPaneKeyForWorktree', () => {
  it('returns the open chat pane key so its agent row highlights', () => {
    const state = {
      activeWorktreeId: 'wt-1',
      activeTabType: 'agent-session' as const,
      // A chat leaves the background terminal's id here, so it cannot identify the chat.
      activeTabId: 'terminal-tab',
      getActiveTab: (worktreeId: string) => (worktreeId === 'wt-1' ? chatTab : null),
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {
        [chatPaneKey]: {
          paneKey: chatPaneKey,
          state: 'working' as const,
          prompt: '',
          updatedAt: 0,
          stateStartedAt: 0,
          stateHistory: []
        }
      },
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {}
    }
    expect(getFocusedAgentPaneKeyForWorktree(state, 'wt-1')).toBe(chatPaneKey)
  })
})
