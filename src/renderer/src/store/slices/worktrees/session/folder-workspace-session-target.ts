import type { AppState } from '../../../types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { resolveFolderWorkspaceCatalogOwnerHostId } from '../../../../../../shared/folder-workspaces'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import { buildWorktreeRenameState } from './worktree-identity-rename-state'

export type FolderWorkspaceSessionTarget = {
  folderWorkspace: FolderWorkspace
  ownerHostId: ExecutionHostId
  workspaceKey: ReturnType<typeof folderWorkspaceKey>
  aliasKey: ReturnType<typeof folderWorkspaceKey>
  canMigrateAlias: boolean
}

export function resolveFolderWorkspaceSessionTarget(
  state: Pick<
    AppState,
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'activeWorktreeId'
    | 'activeWorkspaceKey'
    | 'activeWorkspaceExecutionHostId'
    | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  >,
  folderWorkspaceId: string,
  preferredHostId?: ExecutionHostId
): FolderWorkspaceSessionTarget | null {
  const matches = state.folderWorkspaces.filter((workspace) => workspace.id === folderWorkspaceId)
  const ownerOf = (workspace: FolderWorkspace): ExecutionHostId | null =>
    resolveFolderWorkspaceCatalogOwnerHostId(workspace, state.projectGroups)
  const candidates = preferredHostId
    ? matches.filter((workspace) => ownerOf(workspace) === preferredHostId)
    : matches
  if (candidates.length !== 1) {
    return null
  }
  const folderWorkspace = candidates[0]
  const ownerHostId = ownerOf(folderWorkspace)
  if (!ownerHostId) {
    return null
  }
  const owners = matches.map(ownerOf)
  const ambiguous =
    matches.length > 1 && (owners.some((owner) => owner === null) || new Set(owners).size > 1)
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId, ambiguous ? ownerHostId : undefined)
  const aliasKey = folderWorkspaceKey(folderWorkspaceId, ambiguous ? undefined : ownerHostId)
  const aliasOwnerIsProven =
    !ambiguous ||
    ((state.activeWorktreeId === aliasKey || state.activeWorkspaceKey === aliasKey) &&
      state.activeWorkspaceExecutionHostId === ownerHostId) ||
    state.restoredRuntimeHostIdByWorkspaceSessionKey[aliasKey] === ownerHostId
  return {
    folderWorkspace,
    ownerHostId,
    workspaceKey,
    aliasKey,
    canMigrateAlias: aliasOwnerIsProven && aliasKey !== workspaceKey
  }
}

function hasWorkspaceSessionIdentity(state: AppState, workspaceKey: string): boolean {
  return (
    state.activeWorktreeId === workspaceKey ||
    state.activeWorkspaceKey === workspaceKey ||
    workspaceKey in state.tabsByWorktree ||
    workspaceKey in state.activeFileIdByWorktree ||
    workspaceKey in state.browserTabsByWorktree ||
    workspaceKey in state.unifiedTabsByWorktree ||
    workspaceKey in state.groupsByWorktree ||
    workspaceKey in state.layoutByWorktree ||
    workspaceKey in state.restoredRuntimeHostIdByWorkspaceSessionKey ||
    state.openFiles.some((file) => file.worktreeId === workspaceKey)
  )
}

export function migrateFolderWorkspaceSessionAlias(
  set: WorktreeSliceSet,
  target: FolderWorkspaceSessionTarget,
  state: AppState
): void {
  if (
    !target.canMigrateAlias ||
    !hasWorkspaceSessionIdentity(state, target.aliasKey) ||
    hasWorkspaceSessionIdentity(state, target.workspaceKey)
  ) {
    return
  }
  set((current) => {
    const renamed = buildWorktreeRenameState(current, target.aliasKey, target.workspaceKey)
    const worktreeNavHistory = current.worktreeNavHistory.map((entry) =>
      entry === target.aliasKey ? target.workspaceKey : entry
    )
    return {
      ...renamed,
      ...(current.activeWorkspaceKey === target.aliasKey
        ? { activeWorkspaceKey: target.workspaceKey }
        : {}),
      ...(worktreeNavHistory.some((entry, index) => entry !== current.worktreeNavHistory[index])
        ? { worktreeNavHistory }
        : {})
    }
  })
}

export function findFolderWorkspaceMetadataOwner(
  state: Pick<
    AppState,
    'folderWorkspaces' | 'projectGroups' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'
  >,
  folderWorkspaceId: string,
  preferredHostId?: ExecutionHostId
): FolderWorkspace | null {
  const matches = state.folderWorkspaces.filter((workspace) => workspace.id === folderWorkspaceId)
  const activeScope = parseWorkspaceKey(state.activeWorktreeId ?? '')
  const activeExecutionHostId =
    preferredHostId ??
    (activeScope?.type === 'folder' && activeScope.folderWorkspaceId === folderWorkspaceId
      ? (activeScope.ownerHostId ?? state.activeWorkspaceExecutionHostId)
      : null)
  if (activeExecutionHostId) {
    return (
      matches.find(
        (workspace) =>
          resolveFolderWorkspaceCatalogOwnerHostId(workspace, state.projectGroups) ===
          activeExecutionHostId
      ) ?? null
    )
  }
  return matches.length === 1 ? matches[0] : null
}
