import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../../shared/bots/bot-group'
import { botGroupRoomOfRow, collapseBotGroupRoomRows } from './bot-group-room-history'

const group: BotGroup = {
  id: 'group-1',
  name: 'triage team',
  hostId: 'local',
  revision: 1,
  folder: 'group-triage',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: [
    { botId: 'a', sessionId: 'bot-group-member-a' },
    { botId: 'b', sessionId: 'bot-group-member-b' }
  ],
  threads: [
    {
      id: 'bot-group-thread-1',
      createdAt: 2,
      title: 'Release notes',
      members: [
        { botId: 'a', sessionId: 'bot-group-member-ta' },
        { botId: 'b', sessionId: 'bot-group-member-tb' }
      ]
    },
    { id: 'bot-group-thread-2', createdAt: 3, members: [] }
  ]
}

const row = (id: string, sessionId: string | null, modifiedAt: string) => ({
  id,
  modifiedAt,
  structuredSession: sessionId ? { sessionId, workspaceId: 'fw-bot' } : undefined
})

describe('group rooms in Session History', () => {
  it("lists each room once, as its members' newest row, beside every other row", () => {
    const rows = [
      row('main-a', 'bot-group-member-a', '2026-11-04T10:00:00Z'),
      row('main-b', 'bot-group-member-b', '2026-11-04T11:00:00Z'),
      row('thread-a', 'bot-group-member-ta', '2026-11-04T12:00:00Z'),
      row('thread-b', 'bot-group-member-tb', '2026-11-04T09:00:00Z'),
      row('side-chat', 'bot-side-chat', '2026-11-04T08:00:00Z'),
      row('cli', null, '2026-11-04T07:00:00Z'),
      row('left-member', 'bot-group-member-gone', '2026-11-04T06:00:00Z')
    ]
    expect(collapseBotGroupRoomRows(rows, [group]).map((entry) => entry.id)).toEqual([
      'main-b',
      'thread-a',
      'side-chat',
      'cli',
      'left-member'
    ])
  })

  it('names a row by its room and opens that room', () => {
    expect(botGroupRoomOfRow([group], row('t', 'bot-group-member-tb', 'x'))).toMatchObject({
      roomId: 'bot-group-thread-1',
      label: 'Release notes'
    })
    expect(botGroupRoomOfRow([group], row('m', 'bot-group-member-a', 'x'))).toMatchObject({
      roomId: 'group-1',
      label: 'triage team'
    })
    expect(botGroupRoomOfRow([group], row('s', 'bot-side-chat', 'x'))).toBeNull()
  })
})
