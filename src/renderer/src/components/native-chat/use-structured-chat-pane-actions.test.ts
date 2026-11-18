import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

const mocks = vi.hoisted(() => ({ isBotChatTab: vi.fn((_tab: unknown) => false) }))
vi.mock('../bots/bot-workspace', () => ({ isBotChatTab: mocks.isBotChatTab }))

import { canCloseChatPane } from './pane/actions/use-structured-chat-pane-actions'

function chatTab(fields: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'chat-1',
    groupId: 'group-1',
    worktreeId: 'folder:home',
    contentType: 'agent-session',
    label: 'Home',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned: false,
    ...fields
  }
}

describe('canCloseChatPane', () => {
  it("offers no close on a bot's Home, whose tab never closes", () => {
    mocks.isBotChatTab.mockReturnValueOnce(true)

    expect(canCloseChatPane(2, chatTab())).toBe(false)
    expect(mocks.isBotChatTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'chat-1' }))
  })

  it('keeps the close on other chats, except a pinned one in a single group', () => {
    expect(canCloseChatPane(1, chatTab())).toBe(true)
    expect(canCloseChatPane(1, chatTab({ isPinned: true }))).toBe(false)
    expect(canCloseChatPane(2, chatTab({ isPinned: true }))).toBe(true)
  })
})
