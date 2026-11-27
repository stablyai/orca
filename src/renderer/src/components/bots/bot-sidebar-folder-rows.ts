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
  parentId: string | null
  bucketIndex: number
  expanded?: boolean
}

export type BotSidebarTreeRow<Entry extends TreeEntry> =
  | BotSidebarFolderRow
  | BotSidebarEntryRow<Entry>
  | { kind: 'member'; id: string; entry: Entry; depth: number }

type Child<Entry extends TreeEntry> =
  | { kind: 'folder'; folder: BotSidebarFolder }
  | { kind: 'entry'; entry: Entry }
  | { kind: 'member'; entry: Entry }

export function botSidebarFolderRowId(folderId: string): string {
  return `bot-folder-row:${folderId}`
}

export function getBotSidebarMemberships(
  memberKeysByGroup: ReadonlyMap<string, readonly string[]>
): Map<string, string[]> {
  const groupsByMember = new Map<string, string[]>()
  // A bot's full card has a stable home under multiple memberships; the other rooms link to it.
  for (const groupId of [...memberKeysByGroup.keys()].sort()) {
    for (const memberId of new Set(memberKeysByGroup.get(groupId))) {
      const parents = groupsByMember.get(memberId) ?? []
      parents.push(groupId)
      groupsByMember.set(memberId, parents)
    }
  }
  return groupsByMember
}

/** Projects both navigation folders and group rooms into the virtual sidebar. */
export function buildBotSidebarFolderRows<Entry extends TreeEntry>({
  entries,
  folders,
  folderPlacements,
  groupParents = {},
  groupsByMember = new Map(),
  isExpanded,
  isGroupExpanded = () => true
}: {
  entries: readonly Entry[]
  folders: BotSidebarFolders
  folderPlacements: Readonly<Record<string, string>>
  groupParents?: Readonly<Record<string, string>>
  groupsByMember?: ReadonlyMap<string, readonly string[]>
  isExpanded: (folderId: string) => boolean
  isGroupExpanded?: (groupId: string) => boolean
}): BotSidebarTreeRow<Entry>[] {
  const foldersById = indexBotSidebarFolders(folders)
  const groupIds = new Set(entries.filter((entry) => entry.kind === 'group').map(({ id }) => id))
  const children = new Map<string | null, Child<Entry>[]>()
  const add = (parentId: string | null, child: Child<Entry>): void => {
    const list = children.get(parentId) ?? []
    list.push(child)
    children.set(parentId, list)
  }
  for (const [parentId, nested] of groupBotSidebarFolders(folders)) {
    for (const folder of nested) {
      add(parentId === null ? null : botSidebarFolderRowId(parentId), { kind: 'folder', folder })
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'group') {
      const parent = groupParents[entry.id]
      add(groupIds.has(parent) ? parent : null, { kind: 'entry', entry })
      continue
    }
    const folderId = folderPlacements[entry.id]
    const memberOf = (groupsByMember.get(entry.id) ?? []).filter((id) => groupIds.has(id))
    const parentId = foldersById.has(folderId)
      ? botSidebarFolderRowId(folderId)
      : (memberOf[0] ?? null)
    add(parentId, { kind: 'entry', entry })
    for (const groupId of memberOf) {
      if (groupId !== parentId) {
        add(groupId, { kind: 'member', entry })
      }
    }
  }

  const rows: BotSidebarTreeRow<Entry>[] = []
  const levels: { parentId: string | null; depth: number; next: number; bucketIndex: number }[] = []
  const enter = (parentId: string | null, depth: number): void => {
    levels.push({ parentId, depth, next: 0, bucketIndex: 0 })
  }
  enter(null, 0)
  for (let level = levels.at(-1); level; level = levels.at(-1)) {
    const { parentId, depth } = level
    const child = children.get(parentId)?.[level.next++]
    if (!child) {
      levels.pop()
      continue
    }
    if (child.kind === 'folder') {
      const id = botSidebarFolderRowId(child.folder.id)
      const expanded = isExpanded(child.folder.id)
      rows.push({ ...child, id, depth, expanded, hasChildren: children.has(id) })
      if (expanded) {
        enter(id, depth + 1)
      }
      continue
    }
    const { entry } = child
    if (child.kind === 'member') {
      rows.push({ ...child, id: JSON.stringify([parentId, entry.id]), depth })
      continue
    }
    const expanded =
      entry.kind === 'group' && children.has(entry.id) ? isGroupExpanded(entry.id) : undefined
    rows.push({
      kind: 'entry',
      id: entry.id,
      entry,
      parentId,
      depth,
      bucketIndex: level.bucketIndex++,
      expanded
    })
    if (expanded) {
      enter(entry.id, depth + 1)
    }
  }
  return rows
}
