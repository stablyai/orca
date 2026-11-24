import { describe, expect, it } from 'vitest'
import { planOrphanedChatRekeys, type RemovedProjectTombstone } from './orphaned-chat-rekey'

const OLD = '382f7d9d-4836-4375-9a02-529501637cc7'
const NEW = '7319a84d-f391-4530-b66d-b3ca61acfbb6'
const INSTANCE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const tombstone = (over: Partial<RemovedProjectTombstone> = {}): RemovedProjectTombstone => ({
  repoId: OLD,
  path: '/work/app',
  kind: 'git',
  executionHostId: 'local',
  identity: 'git:root-a',
  ...over
})
const chat = (workspaceId: string, executionHostId = 'local') => ({
  sessionId: `s-${workspaceId}`,
  location: { executionHostId, workspaceId }
})
const gitRepo = { id: NEW, path: '/work/app', kind: 'git' as const }

describe('planOrphanedChatRekeys', () => {
  it('moves chats of the removed project to the NEW repo id, never reusing the old id', () => {
    const moves = planOrphanedChatRekeys(
      [chat(`${OLD}::/work/app`)],
      [tombstone()],
      gitRepo,
      'git:root-a'
    )
    expect(moves).toEqual([
      { sessionId: `s-${OLD}::/work/app`, from: `${OLD}::/work/app`, to: `${NEW}::/work/app` }
    ])
  })

  it('a different repository at the same path inherits nothing', () => {
    expect(
      planOrphanedChatRekeys([chat(`${OLD}::/work/app`)], [tombstone()], gitRepo, 'git:root-b')
    ).toEqual([])
  })

  it('an unreadable identity matches nothing, on either side', () => {
    expect(
      planOrphanedChatRekeys([chat(`${OLD}::/work/app`)], [tombstone()], gitRepo, null)
    ).toEqual([])
    expect(
      planOrphanedChatRekeys(
        [chat(`${OLD}::/work/app`)],
        [tombstone({ identity: null })],
        gitRepo,
        'git:root-a'
      )
    ).toEqual([])
  })

  it('a recreated plain folder at the same path inherits nothing', () => {
    const folder = { id: NEW, path: '/work/notes', kind: 'folder' as const }
    const removed = tombstone({ path: '/work/notes', kind: 'folder', identity: 'folder:1:100' })
    expect(
      planOrphanedChatRekeys([chat(`${OLD}::/work/notes`)], [removed], folder, 'folder:1:200')
    ).toEqual([])
    expect(
      planOrphanedChatRekeys([chat(`${OLD}::/work/notes`)], [removed], folder, 'folder:1:100')
    ).toHaveLength(1)
  })

  it('only moves chats and tombstones of the same execution host', () => {
    expect(
      planOrphanedChatRekeys(
        [chat(`${OLD}::/work/app`, 'ssh:box')],
        [tombstone()],
        gitRepo,
        'git:root-a'
      )
    ).toEqual([])
    expect(
      planOrphanedChatRekeys(
        [chat(`${OLD}::/work/app`)],
        [tombstone({ executionHostId: 'ssh:box' })],
        gitRepo,
        'git:root-a'
      )
    ).toEqual([])
  })

  it('folder-instance chats and other path spellings land on the new root workspace id', () => {
    const folder = { id: NEW, path: String.raw`d:\projects\demo`, kind: 'folder' as const }
    const removed = tombstone({ path: 'D:/projects/demo', kind: 'folder', identity: 'folder:1:7' })
    const moves = planOrphanedChatRekeys(
      [chat(`${OLD}::D:/projects/demo`), chat(`${OLD}::D:/projects/demo::workspace:${INSTANCE}`)],
      [removed],
      folder,
      'folder:1:7'
    )
    expect(moves.map((move) => move.to)).toEqual([
      `${NEW}::d:\\projects\\demo`,
      `${NEW}::d:\\projects\\demo`
    ])
  })

  it('keeps the path of chats in other worktrees of the same git repository', () => {
    const moves = planOrphanedChatRekeys(
      [chat(`${OLD}::/work/app-feature`), chat(`${OLD}::/work/other::workspace:${INSTANCE}`)],
      [tombstone()],
      gitRepo,
      'git:root-a'
    )
    expect(moves.map((move) => move.to)).toEqual([`${NEW}::/work/app-feature`])
  })

  it('ignores chats of live or unrelated repos and malformed ids', () => {
    expect(
      planOrphanedChatRekeys(
        [chat(`${NEW}::/work/app`), chat('11111111::/work/app'), chat('no-separator')],
        [tombstone()],
        gitRepo,
        'git:root-a'
      )
    ).toEqual([])
  })
})
