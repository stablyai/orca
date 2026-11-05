import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { findWorkspaceChatTarget } from './native-chat-workspace-selection'

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

function target(tabs: Tab[], used: Record<string, number> = {}) {
  return findWorkspaceChatTarget(
    {
      unifiedTabsByWorktree: { 'wt-1': tabs },
      terminalLayoutsByTabId: {
        'term-chat': { root: null, activeLeafId: null, expandedLeafId: null, chatLeafId: CHAT_LEAF }
      }
    },
    'wt-1',
    (_worktreeId, entityId) => used[entityId]
  )
}

describe('findWorkspaceChatTarget', () => {
  const structured = tab({
    id: 'tab-structured',
    entityId: 'session-1',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    lastFocusedAt: 10
  })
  const terminalChat = tab({
    id: 'tab-term',
    entityId: 'term-chat',
    contentType: 'terminal',
    viewMode: 'chat',
    lastFocusedAt: 20
  })
  const plainTerminal = tab({ id: 'term-plain', contentType: 'terminal', lastFocusedAt: 99 })
  const editor = tab({ id: '/repo/a.ts', contentType: 'editor', lastFocusedAt: 98 })

  it('targets the chat used last, skipping tabs without a composer', () => {
    expect(target([structured, terminalChat, plainTerminal, editor])).toEqual({
      tab: terminalChat,
      scopeKey: `term-chat:${CHAT_LEAF}`,
      chatLeafId: CHAT_LEAF
    })
    expect(target([{ ...structured, lastFocusedAt: 30 }, terminalChat, plainTerminal])).toEqual({
      tab: { ...structured, lastFocusedAt: 30 },
      scopeKey: 'agent-session:session-1'
    })
  })

  // A click into a chat that is already showing activates nothing, so only its use time says it was used.
  it('counts use of a chat that is already showing, until a later activation', () => {
    expect(target([structured, terminalChat], { 'session-1': 25 })?.tab).toBe(structured)
    expect(
      target([structured, { ...terminalChat, lastFocusedAt: 30 }], { 'session-1': 25 })?.tab
    ).toEqual({ ...terminalChat, lastFocusedAt: 30 })
  })

  it('finds no chat in a workspace of terminals and files', () => {
    expect(target([plainTerminal, editor])).toBeNull()
  })
})
