import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useBots } from '@/lib/bot-catalog'
import { isBotHome } from '../../../../shared/bots/bot-homes'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

type BotWorkerRow = Pick<Worktree, 'id' | 'hostId'>

const NO_FOLDERS: readonly FolderWorkspace[] = []

/** The bot whose home this workspace sits under, while Hide bot workspaces is off and it shows in its project too. */
export function useWorktreeBot(worktree: BotWorkerRow, botsEnabled: boolean): Bot | null {
  // One subscription per card; absent reads as on, like the persisted default.
  const folders = useAppStoreWithHostStatuses((s, statuses) =>
    botsEnabled && s.hideBotCreatedWorkspaces === false
      ? selectFolderAncestors(s, statuses, worktree)
      : NO_FOLDERS
  )
  return botOfFolders(folders, useBots(folders.length > 0))
}

/** The bot owning the nearest of `folders` that is a bot's home. */
export function botOfFolders(
  folders: readonly FolderWorkspace[],
  bots: readonly Bot[]
): Bot | null {
  for (let i = 0; i < folders.length; i += 1) {
    const folder = folders[i]
    for (let j = 0; j < bots.length; j += 1) {
      if (isBotHome(folder, bots[j])) {
        return bots[j]
      }
    }
  }
  return null
}

/** The folder workspaces the sidebar nests this workspace beneath, nearest first. */
export function selectFolderAncestors(
  state: AppState,
  statuses: RuntimeStatuses,
  worktree: BotWorkerRow
): readonly FolderWorkspace[] {
  return (
    selectFolderAncestorsByIdentity(state, statuses).get(getWorktreeHostIdentity(worktree)) ??
    NO_FOLDERS
  )
}

const EMPTY_FOLDER_ANCESTORS: ReadonlyMap<string, readonly FolderWorkspace[]> = new Map()

let lastFolderAncestors: {
  parents: ReturnType<typeof selectSidebarLineageParentIdentities>
  folders: readonly FolderWorkspace[] | undefined
  result: ReadonlyMap<string, readonly FolderWorkspace[]>
} | null = null

// One index over the sidebar's parents, shared by every card.
function selectFolderAncestorsByIdentity(
  state: AppState,
  statuses: RuntimeStatuses
): ReadonlyMap<string, readonly FolderWorkspace[]> {
  const parents = selectSidebarLineageParentIdentities(state, statuses)
  const folders = selectFolderWorkspaces(state)
  const previous = lastFolderAncestors
  if (previous && previous.parents === parents && previous.folders === folders) {
    return previous.result
  }
  if (!parents || parents.size === 0 || !folders || folders.length === 0) {
    lastFolderAncestors = { parents, folders, result: EMPTY_FOLDER_ANCESTORS }
    return EMPTY_FOLDER_ANCESTORS
  }
  const folderByIdentity = new Map<string, FolderWorkspace>()
  for (const folder of folders) {
    folderByIdentity.set(getFolderWorkspaceHostIdentity(folder), folder)
  }
  const result = new Map<string, readonly FolderWorkspace[]>()
  // The sidebar's parents carry no loops, so each chain ends.
  const ancestorsOf = (identity: string): readonly FolderWorkspace[] => {
    const known = result.get(identity)
    if (known) {
      return known
    }
    const parent = parents.get(identity)
    const folder = parent === undefined ? undefined : folderByIdentity.get(parent)
    let ancestors: readonly FolderWorkspace[]
    if (parent === undefined) {
      ancestors = NO_FOLDERS
    } else {
      const parentAncestors = ancestorsOf(parent)
      ancestors = folder
        ? parentAncestors.length === 0
          ? [folder]
          : [folder, ...parentAncestors]
        : parentAncestors
    }
    result.set(identity, ancestors)
    return ancestors
  }
  for (const identity of parents.keys()) {
    ancestorsOf(identity)
  }
  lastFolderAncestors = { parents, folders, result }
  return result
}
