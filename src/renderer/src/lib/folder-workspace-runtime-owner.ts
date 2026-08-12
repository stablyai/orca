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
  folderWorkspaces?: readonly Pick<
    FolderWorkspace,
    'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
  >[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

function getPreferredFolderExecutionHostId(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  if (executionHostId) {
    return executionHostId
  }
  return state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
    ? (state.activeWorkspaceExecutionHostId ?? undefined)
    : undefined
}

export function findFolderWorkspaceOwner(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
> | null {
  return findIndexedFolderWorkspaceOwner(
    state.folderWorkspaces,
    folderWorkspaceId,
    getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  )
}

function findFolderProjectGroup(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const preferredHostId = getPreferredFolderExecutionHostId(
    state,
    folderWorkspaceId,
    executionHostId
  )
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, preferredHostId)
  if (!folderWorkspace) {
    return null
  }
  return findIndexedProjectGroupOwner(
    state.projectGroups,
    folderWorkspace.projectGroupId,
    preferredHostId
  )
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
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, executionHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
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
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, executionHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
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
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): ExecutionHostId {
  const preferredHostId = getPreferredFolderExecutionHostId(
    state,
    folderWorkspaceId,
    executionHostId
  )
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, preferredHostId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId, preferredHostId)
  const parsed = parseExecutionHostId(
    folderWorkspace?.executionHostId ?? projectGroup?.executionHostId
  )
  if (parsed) {
    return parsed.id
  }
  const connectionId = folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  if (preferredHostId && folderWorkspace) {
    return preferredHostId
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.id
  }
  const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}
