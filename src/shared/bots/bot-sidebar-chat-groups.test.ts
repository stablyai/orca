import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from './bot-chat-tree'
import { groupBotWorkspacesByChat, pageSidebarList } from './bot-sidebar-chat-groups'

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
  it('lists only chats with a tab, each with its workspaces; one with no chat goes under Home Chat', () => {
    const home = chat('home', { origin: 'home', tab: true })
    const groups = groupBotWorkspacesByChat(
      [
        chat('slack', { origin: 'slack', tab: true }),
        home,
        chat('untabbed', { tab: false }),
        chat('old', { closed: true })
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      { a: 'slack', b: 'old', c: 'untabbed' }
    )
    expect(groups.map((group) => [group.chat.chatId, group.workspaces.map((w) => w.id)])).toEqual([
      ['home', ['d']],
      ['slack', ['a']]
    ])
  })

  it("lists a chat's waiting workspace first, then running ones, then the rest in given order", () => {
    const running = (worktreeId: string, state: 'running' | 'needs-you') => ({
      key: worktreeId,
      title: worktreeId,
      state,
      startedAt: 0,
      worktreeId
    })
    const home = chat('home', {
      origin: 'home',
      running: [running('c', 'running'), running('d', 'needs-you')]
    })
    const [group] = groupBotWorkspacesByChat(
      [home],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      {}
    )
    expect(group.workspaces.map((w) => w.id)).toEqual(['d', 'c', 'a', 'b'])
  })
})

describe('pageSidebarList', () => {
  it('reveals 8 at a time past the first few', () => {
    expect(pageSidebarList(49, 3, 0)).toEqual({ shown: 3, remaining: 46 })
    expect(pageSidebarList(49, 3, 1)).toEqual({ shown: 11, remaining: 38 })
    expect(pageSidebarList(5, 3, 0)).toEqual({ shown: 3, remaining: 2 })
  })
})
