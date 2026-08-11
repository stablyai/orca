import { parseExecutionHostId } from '../../../shared/execution-host'
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
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>
type FolderOwnerScope = {
  runtimeSourceExecutionHostId?: string | null
}

type PhysicalSourceResolution =
  | { kind: 'resolved'; hostId: ExecutionHostId }
  | { kind: 'none' | 'invalid' }

function resolvePhysicalSourceHostId(
  folderWorkspace: FolderOwnerScope,
  projectGroup: FolderOwnerScope | null
): PhysicalSourceResolution {
  const hostIds = new Set<ExecutionHostId>()
  for (const scope of [folderWorkspace, projectGroup]) {
    if (!scope) {
      continue
    }
    const sourceValue = scope.runtimeSourceExecutionHostId
    if (sourceValue === undefined) {
      continue
    }
    const sourceHostId = parseExecutionHostId(sourceValue)?.id
    if (!sourceHostId) {
      return { kind: 'invalid' }
    }
    hostIds.add(sourceHostId)
  }
  if (hostIds.size > 1) {
    return { kind: 'invalid' }
  }
  const hostId = hostIds.values().next().value as ExecutionHostId | undefined
  return hostId ? { kind: 'resolved', hostId } : { kind: 'none' }
}

export type FolderWorkspaceRuntimeOwnerState = SingleRuntimeLegacyOwnerState & {
  folderWorkspaces?: readonly Pick<
    FolderWorkspace,
    'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
  >[]
  projectGroups?: readonly Pick<
    ProjectGroup,
    'id' | 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
  >[]
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
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
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
): Pick<
  ProjectGroup,
  'id' | 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
> | null {
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
    folderWorkspace?.connectionId !== undefined ||
    projectGroup?.connectionId !== undefined
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
  if (folderWorkspace?.connectionId !== undefined || projectGroup?.connectionId !== undefined) {
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
  if (
    !folderWorkspace &&
    state.folderWorkspaces?.some((workspace) => workspace.id === folderWorkspaceId)
  ) {
    return 'runtime:unresolved-owner'
  }
  if (folderWorkspace) {
    const unresolvedFallbackHostId = 'runtime:unresolved-owner' as const
    const hostId = resolveFolderWorkspaceExecutionHostId({
      folderWorkspace,
      projectGroup,
      fallbackHostId: preferredHostId ?? unresolvedFallbackHostId
    })
    if (!hostId) {
      return unresolvedFallbackHostId
    }
    if (hostId !== unresolvedFallbackHostId) {
      const transportHost = parseExecutionHostId(hostId)
      if (transportHost?.kind !== 'runtime') {
        return hostId
      }
      const source = resolvePhysicalSourceHostId(folderWorkspace, projectGroup)
      if (source.kind === 'invalid') {
        return unresolvedFallbackHostId
      }
      if (source.kind === 'resolved') {
        return source.hostId
      }
      return hostId
    }
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.id
  }
  const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}
