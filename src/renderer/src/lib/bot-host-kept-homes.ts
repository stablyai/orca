// A paired server's bot and group homes, kept with its bots so their rows still show after a restart while it is away.
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { readKeptBotHostList, type KeptBotHome, type KeptBotHostList } from './bot-host-kept-lists'

function keptHome(workspace: FolderWorkspace): KeptBotHome {
  const { id, name, folderPath, executionHostId, projectGroupId, sortOrder, isPinned } = workspace
  return {
    id,
    name,
    folderPath,
    executionHostId,
    projectGroupId,
    sortOrder,
    ...(isPinned ? { isPinned: true } : {})
  }
}

/** The kept list's homes as the app lists them now; a home not loaded yet stays as kept. */
export function keptBotHomes(
  hostId: ExecutionHostId,
  list: KeptBotHostList,
  folderWorkspaces: readonly FolderWorkspace[]
): readonly KeptBotHome[] {
  const homeIds = new Set([
    ...list.bots.map((bot) => bot.folderWorkspaceId),
    ...list.groups.map((group) => group.folderWorkspaceId)
  ])
  const loaded = folderWorkspaces
    .filter(
      (workspace) => homeIds.has(workspace.id) && getRepoExecutionHostId(workspace) === hostId
    )
    .map(keptHome)
  const loadedIds = new Set(loaded.map((home) => home.id))
  return [
    ...loaded,
    ...list.homes.filter((home) => homeIds.has(home.id) && !loadedIds.has(home.id))
  ]
}

/** A kept home as a row reads it: nothing unread, archived or active, since its server is away. */
function restoredHome(home: KeptBotHome): FolderWorkspace {
  return {
    ...home,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: home.isPinned === true,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

/** `folderWorkspaces` with each listed server's kept homes the store doesn't hold, as after a restart while it is away. */
export function withKeptBotHomes(
  folderWorkspaces: readonly FolderWorkspace[],
  hostIds: readonly ExecutionHostId[]
): readonly FolderWorkspace[] {
  const missing = hostIds.flatMap((hostId) =>
    (readKeptBotHostList(hostId)?.homes ?? [])
      .filter(
        (home) =>
          !folderWorkspaces.some(
            (workspace) => workspace.id === home.id && getRepoExecutionHostId(workspace) === hostId
          )
      )
      .map(restoredHome)
  )
  return missing.length === 0 ? folderWorkspaces : [...folderWorkspaces, ...missing]
}
