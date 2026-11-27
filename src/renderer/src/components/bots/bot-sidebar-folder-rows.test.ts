import { expect, it } from 'vitest'
import {
  listBotSidebarFolders,
  normalizeBotSidebarFolderState,
  moveBotSidebarFolder,
  removeBotSidebarFolder,
  type BotSidebarFolder
} from '../../../../shared/bots/bot-sidebar-folders'
import {
  getBotSidebarGroupPath,
  moveBotSidebarGroup,
  removeBotSidebarGroup,
  type BotSidebarGroupParents
} from '../../../../shared/bots/bot-sidebar-group-parents'
import { buildBotSidebarFolderRows, getBotSidebarMemberships } from './bot-sidebar-folder-rows'

it('preserves folders and bot placements when reading, collapsing and editing a deep saved tree', () => {
  const folders = Array.from({ length: 12_000 }, (_, i): BotSidebarFolder => ({
    id: String(i),
    name: `Folder ${i}`,
    parentId: i === 0 ? null : String(i - 1)
  }))
  const folderPlacements = { 'local/qa': '11999', 'paired/qa': '11998' }
  const saved = normalizeBotSidebarFolderState(
    JSON.parse(JSON.stringify({ folders: folders.toReversed(), placements: folderPlacements }))
  )
  expect(listBotSidebarFolders(saved.folders).at(-1)).toEqual({
    folder: { id: '11999', name: 'Folder 11999', parentId: '11998' },
    depth: 11_999
  })
  expect(listBotSidebarFolders(saved.folders, '11998')).toHaveLength(11_998)
  expect(moveBotSidebarFolder(saved.folders, '0', '11999')).toEqual(saved.folders)

  const repaired = removeBotSidebarFolder(saved.folders, saved.placements, '11998')
  expect(repaired.placements).toEqual({ 'local/qa': '11999', 'paired/qa': '11997' })
  expect(repaired.folders.find((folder) => folder.id === '11999')?.parentId).toBe('11997')
  const entries = [
    { id: 'local/qa', kind: 'bot' },
    { id: 'paired/qa', kind: 'bot' },
    { id: 'local/room', kind: 'group' }
  ] as const
  const tree = { entries, folders: repaired.folders, folderPlacements: repaired.placements }
  const allRows = buildBotSidebarFolderRows({ ...tree, isExpanded: () => true })
  expect(allRows.filter((row) => row.kind === 'entry').map((row) => [row.id, row.depth])).toEqual([
    ['local/qa', 11_999],
    ['paired/qa', 11_998],
    ['local/room', 0]
  ])
  expect(
    buildBotSidebarFolderRows({ ...tree, isExpanded: (id) => id !== '0' }).map((row) => row.id)
  ).toEqual(['bot-folder-row:0', 'local/room'])
})

it('keeps nested rooms and direct memberships distinct through save, fold and promotion', () => {
  const parent = 'local/product'
  const middle = 'local/mobile'
  const child = 'local/android'
  const coordinator = 'local/lead'
  const builder = 'local/build'
  const shared = 'runtime:office/qa'
  const entries = [
    { id: parent, kind: 'group' },
    { id: middle, kind: 'group' },
    { id: child, kind: 'group' },
    { id: coordinator, kind: 'bot' },
    { id: builder, kind: 'bot' },
    { id: shared, kind: 'bot' }
  ] as const
  const saved = normalizeBotSidebarFolderState(
    JSON.parse(
      JSON.stringify({
        groupParents: { [child]: middle, [middle]: parent }
      })
    )
  )
  expect(getBotSidebarGroupPath(saved.groupParents, child)).toEqual([child, middle, parent])
  expect(moveBotSidebarGroup(saved.groupParents, parent, child)).toBe(saved.groupParents)
  const groupsByMember = getBotSidebarMemberships(
    new Map([
      [parent, [coordinator, shared]],
      [child, [builder, shared]]
    ])
  )
  const tree = {
    entries,
    folders: [],
    folderPlacements: {},
    groupsByMember,
    isExpanded: () => true
  }
  const take = (parents: BotSidebarGroupParents, folded?: string) => {
    return buildBotSidebarFolderRows({
      ...tree,
      groupParents: parents,
      isGroupExpanded: (id) => id !== folded
    }).flatMap((row) => (row.kind === 'folder' ? [] : [[row.kind, row.entry.id, row.depth]]))
  }
  expect(take(saved.groupParents)).toEqual([
    ['entry', parent, 0],
    ['entry', middle, 1],
    ['entry', child, 2],
    ['entry', builder, 3],
    ['entry', shared, 3],
    ['entry', coordinator, 1],
    ['member', shared, 1]
  ])
  expect(take(saved.groupParents, middle)).toEqual([
    ['entry', parent, 0],
    ['entry', middle, 1],
    ['entry', coordinator, 1],
    ['member', shared, 1]
  ])
  const promoted = removeBotSidebarGroup(saved.groupParents, middle)
  expect(getBotSidebarGroupPath(promoted, child)).toEqual([child, parent])
})
