import { afterEach, expect, it, vi } from 'vitest'
import * as chatPane from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  collectRemovedAttention,
  type AttentionRemovalSnapshot
} from './attention-removal-follow-up'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// PR #45250: removing one terminal marker derived conversation addresses for unrelated chats.
it.each([100, 1000])('skips address derivation for %i chats on terminal dismissal', (count) => {
  vi.useFakeTimers()
  const chats = Array.from({ length: count }, (_, index): Tab => ({
    id: `chat-tab-${index}`,
    entityId: `unrelated-chat-${index}`,
    groupId: 'chat-group',
    worktreeId: 'chat-worktree',
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0
  }))
  const leafId = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
  const before: AttentionRemovalSnapshot = {
    unreadTerminalTabs: { 'terminal-tab': true },
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    tabsByWorktree: {
      'chat-worktree': [],
      'terminal-worktree': [
        {
          id: 'terminal-tab',
          ptyId: null,
          worktreeId: 'terminal-worktree',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    unifiedTabsByWorktree: { 'chat-worktree': chats },
    terminalLayoutsByTabId: {
      'terminal-tab': { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
    }
  }
  const deriveAddress = vi.spyOn(chatPane, 'chatPaneAddressTabId')

  const removed = collectRemovedAttention(before, { ...before, unreadTerminalTabs: {} })

  expect(removed?.workspaceIds).toEqual(new Set(['terminal-worktree']))
  expect(removed?.paneKeys).toEqual(new Set([`terminal-tab:${leafId}`]))
  expect(deriveAddress).not.toHaveBeenCalled()
})
