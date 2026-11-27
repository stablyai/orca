import { beforeEach, expect, it, vi } from 'vitest'
import type { BotGroup } from '../../../shared/bots/bot-group'
import { renameBotGroupRoom } from './bot-group-room-rename'

const rpc = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('./bot-hosts', () => ({ callBotRpc: rpc }))

const group: BotGroup = {
  id: 'group',
  name: 'Release crew',
  hostId: 'local',
  revision: 3,
  createdAt: 1,
  folder: 'release-crew',
  folderWorkspaceId: 'workspace',
  replyMode: { kind: 'mentions' },
  members: [],
  threads: [{ id: 'thread', createdAt: 2, members: [] }]
}
vi.mock('./bot-group-catalog-snapshot', () => ({ readBotGroups: () => [group] }))

beforeEach(() => rpc.mockClear())

it("names a thread by its own title and the original room by its group's name", async () => {
  await renameBotGroupRoom('thread', 'Notes', 'New thread')
  await renameBotGroupRoom('group', 'x'.repeat(100), 'Release crew')
  expect(rpc.mock.calls).toEqual([
    [group, 'bots.groups.renameThread', { groupId: 'group', threadId: 'thread', title: 'Notes' }],
    [group, 'bots.groups.update', { groupId: 'group', revision: 3, name: 'x'.repeat(64) }]
  ])
})

it('sends no rename for an empty or unchanged name', async () => {
  // Committing on blur would otherwise title an untitled thread "New thread".
  await renameBotGroupRoom('thread', 'New thread', 'New thread')
  await renameBotGroupRoom('group', '', 'Release crew')
  await renameBotGroupRoom('group', null, 'Release crew')
  expect(rpc).not.toHaveBeenCalled()
})
