import type { QualifiedFolderHostState } from '../../../shared/folder-workspace-execution-host'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/workspace-record-selectors'
import type { SingleRuntimeLegacyOwnerState } from './single-runtime-legacy-owner'
import { getPairedWebClientEnvironmentId } from './paired-web-client-host'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

export type FolderWorkspaceRuntimeOwnerState = SingleRuntimeLegacyOwnerState & {
  folderWorkspaces?: readonly (Pick<
    FolderWorkspace,
    'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
  > &
    Partial<Pick<FolderWorkspace, 'folderPath'>>)[]
  repos?: QualifiedFolderHostState['repos']
  projectGroups?: QualifiedFolderHostState['projectGroups']
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
  const preferred = getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  const result = resolveQualifiedIndexedFolderWorkspace(state, folderWorkspaceId, preferred)
  if (result.kind === 'selected') {
    return result.value.workspace
  }
  return !state.repos || !state.projectGroups
    ? findIndexedFolderWorkspaceOwner(state.folderWorkspaces, folderWorkspaceId, preferred)
    : null
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
  const qualified = findIndexedProjectGroupOwner(
    state.projectGroups,
    folderWorkspace.projectGroupId,
    preferredHostId
  )
  if (qualified) {
    return qualified
  }
  const group = findIndexedProjectGroupOwner(state.projectGroups, folderWorkspace.projectGroupId)
  return parseExecutionHostId(group?.executionHostId)?.kind === 'runtime' ? group : null
}

function getRestoredRuntimeHostForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string
): RuntimeExecutionHost | null {
  // During catalog hydration, saved per-host session partitions are the only available owner evidence.
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
  const selected = resolveQualifiedIndexedFolderWorkspace(
    state,
    folderWorkspaceId,
    getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  )
  if (selected.kind === 'selected' && selected.value.workspace.folderPath) {
    const host = parseExecutionHostId(selected.value.hostId)
    if (host?.kind === 'runtime') {
      return host.environmentId
    }
  }
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
    return getPairedWebClientEnvironmentId(state)
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.environmentId
  }
  // Why not the Active Server focus: the client stamps every server folder on arrival.
  return getPairedWebClientEnvironmentId(state)
}

export function getExplicitRuntimeEnvironmentIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const selected = resolveQualifiedIndexedFolderWorkspace(
    state,
    folderWorkspaceId,
    getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  )
  if (selected.kind === 'selected' && selected.value.workspace.folderPath) {
    const host = parseExecutionHostId(selected.value.hostId)
    if (host?.kind === 'runtime') {
      return host.environmentId
    }
  }
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

/** The SSH target behind the paired server that owns this folder, when the owning row names one. */
export function getNestedSshTargetIdForFolderWorkspace(
  state: FolderWorkspaceRuntimeOwnerState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null {
  const selected = resolveQualifiedIndexedFolderWorkspace(
    state,
    folderWorkspaceId,
    getPreferredFolderExecutionHostId(state, folderWorkspaceId, executionHostId)
  )
  if (
    selected.kind === 'selected' &&
    selected.value.workspace.folderPath &&
    parseExecutionHostId(selected.value.hostId)?.kind === 'runtime'
  ) {
    return selected.value.connectionId
  }
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
  const owner = folderWorkspace?.executionHostId
    ? folderWorkspace
    : findFolderProjectGroup(state, folderWorkspaceId, executionHostId)
  return owner && parseExecutionHostId(owner.executionHostId)?.kind === 'runtime'
    ? owner.connectionId?.trim() || null
    : null
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
  const selected = resolveQualifiedIndexedFolderWorkspace(state, folderWorkspaceId, preferredHostId)
  if (selected.kind === 'selected' && selected.value.workspace.folderPath) {
    return selected.value.hostId
  }
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
  const environmentId = getPairedWebClientEnvironmentId(state)
  return environmentId ? toRuntimeExecutionHostId(environmentId) : 'local'
}
