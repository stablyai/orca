import { describe, expect, it } from 'vitest'
import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  collectRemovedAttention,
  type AttentionRemovalSnapshot
} from './attention-removal-follow-up'

function snapshot(
  completions: Record<string, StoredAgentAttentionUnread>
): AttentionRemovalSnapshot {
  return {
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: completions,
    tabsByWorktree: {},
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'agent-chat-tab-v1-7a1c',
          entityId: 'chat-1',
          groupId: 'g1',
          worktreeId: 'wt-1',
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

describe('a read completion on a chat whose tab id is not built from its conversation', () => {
  it('names the chat workspace, so its unread flag settles', () => {
    const removed = collectRemovedAttention(
      snapshot({ [chatPaneKey('chat-1')]: true }),
      snapshot({})
    )
    expect([...(removed?.workspaceIds ?? [])]).toEqual(['wt-1'])
  })
})
