import type {
  BotSidebarFolder,
  BotSidebarFolders
} from '../../../../shared/bots/bot-sidebar-folders'
import {
  groupBotSidebarFolders,
  indexBotSidebarFolders
} from '../../../../shared/bots/bot-sidebar-folders'

type TreeEntry = { kind: 'bot' | 'group'; id: string }

export type BotSidebarFolderRow = {
  kind: 'folder'
  id: string
  folder: BotSidebarFolder
  depth: number
  expanded: boolean
  hasChildren: boolean
}

export type BotSidebarEntryRow<Entry extends TreeEntry> = {
  kind: 'entry'
  id: string
  entry: Entry
  depth: number
  /** The folder that holds it, null at the root; groups always list at the root. */
  folderId: string | null
  /** Its position among the same folder's entries, for that folder's reorder. */
  bucketIndex: number
}

export type BotSidebarTreeRow<Entry extends TreeEntry> =
  | BotSidebarFolderRow
  | BotSidebarEntryRow<Entry>

const FOLDER_ROW_ID_PREFIX = 'bot-folder-row:'

export function botSidebarFolderRowId(folderId: string): string {
  return `${FOLDER_ROW_ID_PREFIX}${folderId}`
}

/**
 * The visible tree as a flat row list: each folder's subfolders, then its bots, depth first.
 * Placements to folders that no longer exist fall back to the root rather than hiding a bot.
 */
export function buildBotSidebarFolderRows<Entry extends TreeEntry>({
  entries,
  folders,
  folderPlacements,
  isExpanded
}: {
  /** The section's arranged rows, before folder grouping. */
  entries: readonly Entry[]
  folders: BotSidebarFolders
  folderPlacements: Readonly<Record<string, string>>
  isExpanded: (folderId: string) => boolean
}): BotSidebarTreeRow<Entry>[] {
  const byId = indexBotSidebarFolders(folders)
  const childFolders = groupBotSidebarFolders(folders)
  const entriesByFolder = new Map<string | null, Entry[]>()
  for (const entry of entries) {
    const placed = entry.kind === 'bot' ? folderPlacements[entry.id] : undefined
    const folderId = placed !== undefined && byId.has(placed) ? placed : null
    const siblings = entriesByFolder.get(folderId) ?? []
    siblings.push(entry)
    entriesByFolder.set(folderId, siblings)
  }
  const rows: BotSidebarTreeRow<Entry>[] = []
  const levels: { parentId: string | null; depth: number; nextChild: number }[] = [
    { parentId: null, depth: 0, nextChild: 0 }
  ]
  for (let level = levels.at(-1); level; level = levels.at(-1)) {
    const { parentId, depth } = level
    const folder = childFolders.get(parentId)?.[level.nextChild]
    if (folder) {
      level.nextChild += 1
      const expanded = isExpanded(folder.id)
      rows.push({
        kind: 'folder',
        id: botSidebarFolderRowId(folder.id),
        folder,
        depth,
        expanded,
        hasChildren:
          (childFolders.get(folder.id)?.length ?? 0) > 0 ||
          (entriesByFolder.get(folder.id)?.length ?? 0) > 0
      })
      if (expanded) {
        levels.push({ parentId: folder.id, depth: depth + 1, nextChild: 0 })
      }
      continue
    }
    levels.pop()
    const entriesHere = entriesByFolder.get(parentId) ?? []
    entriesHere.forEach((entry, bucketIndex) => {
      rows.push({
        kind: 'entry',
        id: entry.id,
        entry,
        depth,
        folderId: parentId,
        bucketIndex
      })
    })
  }
  return rows
}
