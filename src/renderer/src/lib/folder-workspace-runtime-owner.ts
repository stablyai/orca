import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../../shared/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'
import {
  getSingleFocusedRuntimeEnvironmentId,
  type SingleRuntimeLegacyOwnerState
} from './single-runtime-legacy-owner'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

export type FolderWorkspaceRuntimeOwnerState = SingleRuntimeLegacyOwnerState & {
  folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'>[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
}

export function findFolderWorkspaceOwner(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'> | null {
  return findIndexedFolderWorkspaceOwner(state.folderWorkspaces, folderWorkspaceId)
}

function findFolderProjectGroup(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId)
  if (!folderWorkspace) {
    return null
  }
  return findIndexedProjectGroupOwner(state.projectGroups, folderWorkspace.projectGroupId)
}

function getRestoredRuntimeHostForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): RuntimeExecutionHost | null {
  // Why: runtime folder catalogs load after session hydration; the saved
  // per-host session partition is the only owner evidence during that gap.
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const parsed = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[workspaceKey]
  )
  return parsed?.kind === 'runtime' ? parsed : null
}

export function getRuntimeEnvironmentIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  if (
    parsed?.kind === 'local' ||
    parsed?.kind === 'ssh' ||
    folderWorkspace?.connectionId?.trim() ||
    projectGroup?.connectionId?.trim()
  ) {
    return null
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.environmentId
  }
  return getSingleFocusedRuntimeEnvironmentId(state)
}

export function getExplicitRuntimeEnvironmentIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.environmentId : null
  }
  if (folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()) {
    return null
  }
  return getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)?.environmentId ?? null
}

export function getExecutionHostIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed) {
    return parsed.id
  }
  const connectionId = folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.id
  }
  const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}
