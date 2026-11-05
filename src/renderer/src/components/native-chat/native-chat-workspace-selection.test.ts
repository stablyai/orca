import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
import { withAddToChatEligibility, workspaceChatTargetFor } from './native-chat-workspace-selection'

const CHAT_LEAF = '6f1c2a4e-8b3d-4c5a-9e7f-1a2b3c4d5e6f'

function tab(partial: Partial<Tab> & Pick<Tab, 'id' | 'contentType'>): Tab {
  return {
    entityId: partial.id,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    label: partial.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...partial
  }
}

const SHELL_LEAF = '7a2d3b5f-9c4e-4d6b-8f80-2b3c4d5e6f70'

const structured = tab({
  id: 'tab-structured',
  entityId: 'session-1',
  contentType: 'agent-session',
  agentSessionAgent: 'claude'
})
const terminalChat = tab({
  id: 'tab-term',
  entityId: 'term-chat',
  contentType: 'terminal',
  viewMode: 'chat'
})
const plainTerminal = tab({ id: 'tab-plain', entityId: 'term-plain', contentType: 'terminal' })
const state = {
  unifiedTabsByWorktree: { 'wt-1': [structured, terminalChat, plainTerminal] },
  terminalLayoutsByTabId: {
    'term-chat': { root: null, activeLeafId: null, expandedLeafId: null, chatLeafId: CHAT_LEAF },
    'term-plain': { root: null, activeLeafId: null, expandedLeafId: null }
  }
}

describe('workspaceChatTargetFor', () => {
  it('maps a picked agent to the composer that holds its unsent text', () => {
    expect(
      workspaceChatTargetFor(state, 'wt-1', { kind: 'structured-session', sessionId: 'session-1' })
    ).toEqual({ tab: structured, scopeKey: 'agent-session:session-1' })
    expect(
      workspaceChatTargetFor(state, 'wt-1', {
        kind: 'terminal',
        tabId: 'term-chat',
        leafId: CHAT_LEAF
      })
    ).toEqual({ tab: terminalChat, scopeKey: `term-chat:${CHAT_LEAF}`, chatLeafId: CHAT_LEAF })
  })

  // Only the chat's own pane has a composer; a plain terminal agent or a split shell beside the chat has none.
  it('finds no composer for a plain terminal agent or another pane of a chat tab', () => {
    expect(
      workspaceChatTargetFor(state, 'wt-1', {
        kind: 'terminal',
        tabId: 'term-plain',
        leafId: CHAT_LEAF
      })
    ).toBeNull()
    expect(
      workspaceChatTargetFor(state, 'wt-1', {
        kind: 'terminal',
        tabId: 'term-chat',
        leafId: SHELL_LEAF
      })
    ).toBeNull()
  })

  it('disables a picker row with no composer and leaves other rows as they are', () => {
    const row = (messageTarget: NotesSendAgentTarget['messageTarget']): NotesSendAgentTarget => ({
      paneKey: 'pane',
      tabId: 'tab',
      messageTarget,
      agentType: 'claude',
      tabTitle: '',
      status: 'eligible'
    })
    const chatRow = row({ kind: 'structured-session', sessionId: 'session-1' })
    expect(withAddToChatEligibility(chatRow, state, 'wt-1')).toBe(chatRow)
    expect(
      withAddToChatEligibility(
        row({ kind: 'terminal', tabId: 'term-plain', leafId: CHAT_LEAF }),
        state,
        'wt-1'
      )
    ).toMatchObject({
      status: 'disabled',
      disabledReason: 'Switch this terminal to chat view to add text to it'
    })
  })
})
