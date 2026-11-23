import { describe, expect, it } from 'vitest'
import {
  getProjectGroupHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import {
  botGroupFoldToOpen,
  botGroupMemberDragId,
  botSidebarFolderDrag,
  nestBotSidebarEntries
} from './bot-group-folders'

const noOrder: number | undefined = undefined
const bot = (id: string, sidebarOrder?: number) => ({ kind: 'bot' as const, id, sidebarOrder })
const group = (
  id: string,
  botIds: string[],
  remote: { environmentId: string; botId: string }[] = []
) => ({
  kind: 'group' as const,
  id: `local/${id}`,
  sidebarOrder: noOrder,
  group: {
    hostId: 'local' as const,
    id,
    members: botIds.map((botId) => ({ botId, sessionId: `s-${botId}` })),
    remoteMembers: remote.map((member) => ({
      ...member,
      chatSessionId: 'c',
      computer: 'Build box',
      joinedAfter: 0,
      name: member.botId,
      avatar: null,
      agent: 'claude' as const
    }))
  }
})

// Already in the section's sort order, as useBotSidebarArrangement hands them over.
const entries = [
  bot('local/a', 0),
  group('writers', ['b', 'a'], [{ environmentId: 'env1', botId: 'r' }]),
  bot('local/solo', 2),
  bot('local/b', 3),
  group('reviewers', ['b']),
  bot('runtime:env1/r', 5)
]

describe('bot group folders', () => {
  it('lists each member under every group holding it, in sort order, and never at the top', () => {
    const folders = nestBotSidebarEntries(entries, new Set())
    expect(folders.map((folder) => [folder.id, folder.members.map((member) => member.id)])).toEqual(
      [
        ['local/writers', ['local/a', 'local/b', 'runtime:env1/r']],
        ['local/solo', []],
        ['local/reviewers', ['local/b']]
      ]
    )
  })

  it('folds a group by its saved key and stops listing its members inside it', () => {
    const [writers] = nestBotSidebarEntries(entries, new Set(['bot-group:local/writers']))
    expect(writers).toMatchObject({ folded: true, nestedIds: [] })
    expect(botSidebarFolderDrag([writers!], () => undefined).idsByBucket.size).toBe(1)
  })

  it("keeps a member's drag inside its own group's rows", () => {
    const folders = nestBotSidebarEntries(entries, new Set())
    const { idsByBucket, items } = botSidebarFolderDrag(folders, (entry) => entry.sidebarOrder)
    expect(idsByBucket.get('root')).toEqual(['local/writers', 'local/solo', 'local/reviewers'])

    const dragged = botGroupMemberDragId('local/writers', 'local/b')
    const bucket = getProjectGroupHeaderDragBucketKey(items.get(dragged)!, items)
    expect(idsByBucket.get(bucket)).toEqual([
      botGroupMemberDragId('local/writers', 'local/a'),
      dragged,
      botGroupMemberDragId('local/writers', 'runtime:env1/r')
    ])
    // Dropped past the group's last member, it lands last in the group; only members get new orders.
    const updates = getProjectGroupTabOrderUpdatesForSidebarDrop({
      sidebarProjectGroupHeaderIds: idsByBucket.get(bucket)!,
      draggedGroupId: dragged,
      sidebarDropIndex: 99,
      projectGroupById: items
    })
    expect(
      updates.map(({ groupId, tabOrder }) => [items.get(groupId)!.entry.id, tabOrder])
    ).toEqual([
      ['runtime:env1/r', 1],
      ['local/b', 2]
    ])
  })

  it('opens the first folded group holding a revealed bot, unless an open one lists it', () => {
    const groups = entries.flatMap((entry) => (entry.kind === 'group' ? [entry.group] : []))
    const bothFolded = new Set(['bot-group:local/writers', 'bot-group:local/reviewers'])
    expect(botGroupFoldToOpen('local/b', groups, bothFolded)).toBe('bot-group:local/writers')
    expect(botGroupFoldToOpen('local/b', groups, new Set(['bot-group:local/writers']))).toBeNull()
    expect(botGroupFoldToOpen('runtime:env1/r', groups, bothFolded)).toBe('bot-group:local/writers')
    expect(botGroupFoldToOpen('local/solo', groups, bothFolded)).toBeNull()
  })
})
