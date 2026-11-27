import { describe, expect, it } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { botItemForChat } from './activity-inbox-chat-item'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only tab.id.
const chat = { tab: { id: structuredAgentSessionTabId('s1') } } as Pick<AgentPaneThread, 'tab'>

function item(uid: string, status: BotItem['status'], at: number, chatId = 's1'): BotItem {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only these fields.
  return {
    uid,
    status,
    lastActivityAt: at,
    chat: { id: chatId },
    madeBy: null
  } as unknown as BotItem
}

describe('botItemForChat', () => {
  it('prefers the item waiting on you, then an open one, then the newest', () => {
    expect(
      botItemForChat(chat, [
        item('done', 'done', 9),
        item('open', 'planned', 5),
        item('ask', 'needs_you', 1)
      ])?.uid
    ).toBe('ask')
    expect(botItemForChat(chat, [item('done', 'done', 9), item('open', 'planned', 5)])?.uid).toBe(
      'open'
    )
  })

  it('ignores other chats, and a pane that is not a chat', () => {
    expect(botItemForChat(chat, [item('other', 'needs_you', 1, 's2')])).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const terminal = { tab: { id: 'terminal-1' } } as Pick<AgentPaneThread, 'tab'>
    expect(botItemForChat(terminal, [item('ask', 'needs_you', 1)])).toBeNull()
  })
})
