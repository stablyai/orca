import { useBots } from '@/lib/bot-catalog'
import { isHome } from '../../../../shared/bots/bot-homes'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
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
  const folders = useAppStore((s) =>
    botsEnabled && s.hideBotCreatedWorkspaces === false
      ? selectFolderAncestors(s, worktree)
      : NO_FOLDERS
  )
  return botOfFolders(folders, useBots(folders.length > 0))
}

/** The bot owning the nearest of `folders` that is a bot's home. */
export function botOfFolders(
  folders: readonly FolderWorkspace[],
  bots: readonly Bot[]
): Bot | null {
  for (const folder of folders) {
    const bot = bots.find((entry) => isHome(folder, [entry]))
    if (bot) {
      return bot
    }
  }
  return null
}

/** The folder workspaces the sidebar nests this workspace beneath, nearest first. */
export function selectFolderAncestors(
  state: AppState,
  worktree: BotWorkerRow
): readonly FolderWorkspace[] {
  return selectFolderAncestorsByIdentity(state).get(getWorktreeHostIdentity(worktree)) ?? NO_FOLDERS
}

let lastFolderAncestors: {
  inputs: readonly unknown[]
  result: ReadonlyMap<string, readonly FolderWorkspace[]>
} | null = null

// One index over the sidebar's parents, shared by every card.
function selectFolderAncestorsByIdentity(
  state: AppState
): ReadonlyMap<string, readonly FolderWorkspace[]> {
  const parents = selectSidebarLineageParentIdentities(state)
  const inputs = [parents, selectFolderWorkspaces(state)]
  const previous = lastFolderAncestors
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) {
    return previous.result
  }
  const folderByIdentity = new Map(
    (selectFolderWorkspaces(state) ?? []).map((folder) => [
      getFolderWorkspaceHostIdentity(folder),
      folder
    ])
  )
  const result = new Map<string, readonly FolderWorkspace[]>()
  // The sidebar's parents carry no loops, so each chain ends.
  const ancestorsOf = (identity: string): readonly FolderWorkspace[] => {
    const known = result.get(identity)
    if (known) {
      return known
    }
    const parent = parents?.get(identity)
    const folder = parent === undefined ? undefined : folderByIdentity.get(parent)
    const ancestors =
      parent === undefined ? NO_FOLDERS : [...(folder ? [folder] : []), ...ancestorsOf(parent)]
    result.set(identity, ancestors)
    return ancestors
  }
  for (const identity of parents?.keys() ?? []) {
    ancestorsOf(identity)
  }
  lastFolderAncestors = { inputs, result }
  return result
}
