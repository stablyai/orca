/** A named folder in the Bots sidebar: a saved, arbitrary-depth parent/child tree. */
export type BotSidebarFolder = {
  id: string
  name: string
  /** null at the section's root. */
  parentId: string | null
}

export type BotSidebarFolders = readonly BotSidebarFolder[]

/** Host-qualified `botSidebarEntryKey` to the folder holding that bot, kept while its host is away. */
export type BotSidebarFolderPlacements = Readonly<Record<string, string>>

export type BotSidebarFolderState = {
  folders: BotSidebarFolders
  placements: BotSidebarFolderPlacements
}

export const EMPTY_BOT_SIDEBAR_FOLDER_STATE: BotSidebarFolderState = {
  folders: [],
  placements: {}
}

export function normalizeBotSidebarFolderState(value: unknown): BotSidebarFolderState {
  if (!isRecord(value)) {
    return EMPTY_BOT_SIDEBAR_FOLDER_STATE
  }
  return {
    folders: normalizeBotSidebarFolders(value.folders),
    placements: normalizeBotSidebarFolderPlacements(value.placements)
  }
}

const BOT_SIDEBAR_FOLDER_GROUP_PREFIX = 'bot-folder:'

/** The fold key of a folder row, in the same persisted set as the sidebar's other folds. */
export function getBotSidebarFolderGroupKey(folderId: string): string {
  return `${BOT_SIDEBAR_FOLDER_GROUP_PREFIX}${folderId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validParentId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Saved folders with bad entries dropped and bad edges repaired: missing or self parents become
 * the root, and a cycle is broken at one of its folders so every folder stays reachable.
 */
function normalizeBotSidebarFolders(value: unknown): BotSidebarFolder[] {
  if (!Array.isArray(value)) {
    return []
  }
  const folders: BotSidebarFolder[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') {
      continue
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '' || ids.has(raw.id)) {
      continue
    }
    ids.add(raw.id)
    folders.push({ id: raw.id, name: raw.name.trim(), parentId: validParentId(raw.parentId) })
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  for (const folder of folders) {
    if (folder.parentId !== null && !byId.has(folder.parentId)) {
      folder.parentId = null
    }
  }
  const resolved = new Set<string>()
  for (const folder of folders) {
    const path = new Set<string>()
    let current: BotSidebarFolder | undefined = folder
    while (current && !resolved.has(current.id)) {
      path.add(current.id)
      const { parentId } = current
      if (parentId === null) {
        break
      }
      if (path.has(parentId)) {
        current.parentId = null
        break
      }
      current = byId.get(parentId)
    }
    for (const id of path) {
      resolved.add(id)
    }
  }
  return folders
}

/** Saved placements, keeping even folders that are not in this profile's folder list. */
function normalizeBotSidebarFolderPlacements(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {}
  }
  const placements: Record<string, string> = {}
  for (const [entryKey, folderId] of Object.entries(value)) {
    if (
      entryKey !== '' &&
      entryKey !== '__proto__' &&
      typeof folderId === 'string' &&
      folderId !== ''
    ) {
      placements[entryKey] = folderId
    }
  }
  return placements
}

export function indexBotSidebarFolders(
  folders: BotSidebarFolders
): ReadonlyMap<string, BotSidebarFolder> {
  return new Map(folders.map((folder) => [folder.id, folder]))
}

/** Nearest parent first, for unfolding a path to a row. */
function getBotSidebarFolderAncestorIds(
  folders: BotSidebarFolders,
  folderId: string | null | undefined
): string[] {
  if (!folderId) {
    return []
  }
  const byId = indexBotSidebarFolders(folders)
  const ancestors: string[] = []
  const seen = new Set<string>()
  let parentId = byId.get(folderId)?.parentId ?? null
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId)
    ancestors.push(parentId)
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return ancestors
}

/** Groups folders by parent, with root folders at null. */
export function groupBotSidebarFolders(
  folders: BotSidebarFolders
): ReadonlyMap<string | null, readonly BotSidebarFolder[]> {
  const byId = indexBotSidebarFolders(folders)
  const children = new Map<string | null, BotSidebarFolder[]>()
  for (const folder of folders) {
    const parentId = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null
    const siblings = children.get(parentId) ?? []
    siblings.push(folder)
    children.set(parentId, siblings)
  }
  return children
}

/** Every folder depth first. A folder being moved cannot be a destination or contain one. */
export function listBotSidebarFolders(
  folders: BotSidebarFolders,
  excludedFolderId?: string
): { folder: BotSidebarFolder; depth: number }[] {
  const children = groupBotSidebarFolders(folders)
  const listed: { folder: BotSidebarFolder; depth: number }[] = []
  const pending: typeof listed = []
  const queueChildren = (parentId: string | null, depth: number): void => {
    const siblings = children.get(parentId) ?? []
    for (let index = siblings.length - 1; index >= 0; index -= 1) {
      pending.push({ folder: siblings[index]!, depth })
    }
  }
  queueChildren(null, 0)
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (next.folder.id !== excludedFolderId) {
      listed.push(next)
      queueChildren(next.folder.id, next.depth + 1)
    }
  }
  return listed
}

/** The folder and its parent chain, nearest first, for unfolding a saved path. */
export function getBotSidebarFolderPathIds(
  folders: BotSidebarFolders,
  folderId: string | null | undefined
): string[] {
  return folderId && folders.some((folder) => folder.id === folderId)
    ? [folderId, ...getBotSidebarFolderAncestorIds(folders, folderId)]
    : []
}

/** Whether `folderId` is `ancestorId` or sits anywhere below it. */
function isBotSidebarFolderWithin(
  folders: BotSidebarFolders,
  folderId: string,
  ancestorId: string
): boolean {
  return (
    folderId === ancestorId ||
    getBotSidebarFolderAncestorIds(folders, folderId).includes(ancestorId)
  )
}

/** A folder can move to the root, or under a folder outside its own subtree. */
export function canMoveBotSidebarFolder(
  folders: BotSidebarFolders,
  folderId: string,
  parentId: string | null
): boolean {
  if (!indexBotSidebarFolders(folders).has(folderId)) {
    return false
  }
  if (parentId === null) {
    return true
  }
  if (parentId === folderId || !indexBotSidebarFolders(folders).has(parentId)) {
    return false
  }
  return !isBotSidebarFolderWithin(folders, parentId, folderId)
}

export function moveBotSidebarFolder(
  folders: BotSidebarFolders,
  folderId: string,
  parentId: string | null
): BotSidebarFolder[] {
  if (!canMoveBotSidebarFolder(folders, folderId, parentId)) {
    return [...folders]
  }
  return folders.map((folder) => (folder.id === folderId ? { ...folder, parentId } : folder))
}

export function renameBotSidebarFolder(
  folders: BotSidebarFolders,
  folderId: string,
  name: string
): BotSidebarFolder[] {
  const trimmed = name.trim()
  if (trimmed === '') {
    return [...folders]
  }
  return folders.map((folder) => (folder.id === folderId ? { ...folder, name: trimmed } : folder))
}

/** Adds a folder, ignoring an empty name or a parent that does not exist. */
export function addBotSidebarFolder(
  folders: BotSidebarFolders,
  folder: BotSidebarFolder
): BotSidebarFolder[] {
  const name = folder.name.trim()
  if (name === '' || folder.id === '' || folders.some((candidate) => candidate.id === folder.id)) {
    return [...folders]
  }
  if (folder.parentId !== null && !folders.some((candidate) => candidate.id === folder.parentId)) {
    return [...folders]
  }
  return [...folders, { ...folder, name }]
}

export function withBotSidebarFolderPlacement(
  placements: BotSidebarFolderPlacements,
  entryKey: string,
  folderId: string | null
): Record<string, string> {
  const next = { ...placements }
  if (entryKey === '__proto__') {
    return next
  }
  if (folderId === null) {
    delete next[entryKey]
  } else {
    next[entryKey] = folderId
  }
  return next
}

/**
 * Removes only the folder: its subfolders and the bots directly in it move to its parent, so
 * neither bots nor folders are lost and no bot can become hidden by a dangling placement.
 */
export function removeBotSidebarFolder(
  folders: BotSidebarFolders,
  placements: BotSidebarFolderPlacements,
  folderId: string
): { folders: BotSidebarFolder[]; placements: Record<string, string> } {
  const target = folders.find((folder) => folder.id === folderId)
  if (!target) {
    return { folders: [...folders], placements: { ...placements } }
  }
  const parentId = target.parentId
  const nextFolders = folders
    .filter((folder) => folder.id !== folderId)
    .map((folder) => (folder.parentId === folderId ? { ...folder, parentId } : folder))
  const nextPlacements: Record<string, string> = {}
  for (const [entryKey, heldBy] of Object.entries(placements)) {
    if (entryKey === '__proto__') {
      continue
    }
    if (heldBy !== folderId) {
      nextPlacements[entryKey] = heldBy
    } else if (parentId !== null) {
      nextPlacements[entryKey] = parentId
    }
  }
  return { folders: nextFolders, placements: nextPlacements }
}
