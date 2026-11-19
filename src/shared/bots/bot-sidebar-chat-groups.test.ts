import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from './bot-chat-tree'
import { groupBotWorkspacesByChat } from './bot-sidebar-chat-groups'

const chat = (chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 0,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...extra
})

describe('groupBotWorkspacesByChat', () => {
  it('lists workspaces under their open chats, with waiting and running ones first', () => {
    const home = chat('home', {
      origin: 'home',
      tab: true,
      running: [
        { key: 'running', title: 'Running', state: 'running', startedAt: 0, worktreeId: 'c' },
        { key: 'waiting', title: 'Waiting', state: 'needs-you', startedAt: 0, worktreeId: 'd' }
      ]
    })
    const groups = groupBotWorkspacesByChat(
      [
        chat('slack', { origin: 'slack', tab: true }),
        home,
        chat('untabbed', { tab: false }),
        chat('old', { closed: true })
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }],
      { a: 'slack', b: 'old', f: 'untabbed' }
    )
    expect(groups.map((group) => [group.chat.chatId, group.workspaces.map((w) => w.id)])).toEqual([
      ['home', ['d', 'c', 'e', 'g']],
      ['slack', ['a']]
    ])
  })
})
