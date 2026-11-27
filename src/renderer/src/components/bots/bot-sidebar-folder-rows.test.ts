import { expect, it } from 'vitest'
import {
  listBotSidebarFolders,
  normalizeBotSidebarFolderState,
  moveBotSidebarFolder,
  removeBotSidebarFolder,
  type BotSidebarFolder
} from '../../../../shared/bots/bot-sidebar-folders'
import { buildBotSidebarFolderRows } from './bot-sidebar-folder-rows'

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
