import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type { FolderWorkspace, GlobalSettings, ProjectGroup, Worktree } from '../../../shared/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedRepoOwner as findRepoRecord,
  findIndexedWorktreeOwner as findWorktreeRecord,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import {
  resolveExplicitWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResult
} from './worktree-operation-route'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
export type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
export { getRuntimeSessionMirrorEnvironmentIds } from './runtime-session-mirror-owners'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

function findFolderProjectGroup(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
  if (!folderWorkspace) {
    return null
  }
  return findIndexedProjectGroupOwner(state.projectGroups, folderWorkspace.projectGroupId)
}

function findFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'> | null {
  return findIndexedFolderWorkspaceOwner(state.folderWorkspaces, folderWorkspaceId)
}

function getRuntimeEnvironmentIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
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

function getRestoredRuntimeHostForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
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

function getExplicitRuntimeEnvironmentIdFromHost(
  executionHostId: string | null | undefined
): string | null {
  const parsed = parseExecutionHostId(executionHostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

function getProjectedRuntimeOwnerEnvironmentId(
  worktree: Pick<Worktree, 'runtimeOwnerEnvironmentId'> | null | undefined
): string | null {
  return worktree?.runtimeOwnerEnvironmentId?.trim() || null
}

function getExecutionHostIdFromWorktreeHost(
  hostId: string | null | undefined
): ExecutionHostId | null {
  return parseExecutionHostId(hostId)?.id ?? null
}

function getExplicitRuntimeEnvironmentIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
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

function getExecutionHostIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
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

export function getRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getRuntimeEnvironmentIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const indexedOwner = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (indexedOwner.kind === 'ambiguous') {
    return null
  }
  if (indexedOwner.kind === 'resolved') {
    const owner = indexedOwner.owner
    const projectedRuntimeOwner = getProjectedRuntimeOwnerEnvironmentId(owner)
    const parsedHost = parseExecutionHostId(owner.hostId)
    const hasDetectedOwner = Object.values(state.detectedWorktreesByRepo ?? {}).some((result) =>
      result.worktrees.some((worktree) => worktree.id === worktreeId)
    )
    if (!hasDetectedOwner && (projectedRuntimeOwner || parsedHost)) {
      return (
        projectedRuntimeOwner || (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null)
      )
    }
    if (!hasDetectedOwner) {
      const repoResolution = resolveIndexedRepoOwner(state.repos, owner.repoId)
      if (repoResolution.kind === 'ambiguous') {
        return null
      }
      if (
        repoResolution.kind === 'resolved' &&
        (repoResolution.owner.executionHostId?.trim() || repoResolution.owner.connectionId?.trim())
      ) {
        const repoHost = parseExecutionHostId(getRepoExecutionHostId(repoResolution.owner))
        if (repoHost) {
          return repoHost.kind === 'runtime' ? repoHost.environmentId : null
        }
      }
    }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId : null
}

export function getExplicitRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExplicitRuntimeEnvironmentIdForFolderWorkspace(
      state,
      workspaceScope.folderWorkspaceId
    )
  }
  const hasDetectedOwner = Object.values(state.detectedWorktreesByRepo ?? {}).some((result) =>
    result.worktrees.some((worktree) => worktree.id === worktreeId)
  )
  if (hasDetectedOwner) {
    // Why: detected-only rows are selectable before the primary catalog lands; use the same
    // ambiguity-aware explicit provenance as filesystem and terminal operations.
    const resolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
    return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId : null
  }
  if (resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId).kind === 'ambiguous') {
    return null
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, worktreeId)
  const projectedRuntimeOwner = getProjectedRuntimeOwnerEnvironmentId(worktree)
  if (projectedRuntimeOwner) {
    return projectedRuntimeOwner
  }
  const parsedWorktreeHost = parseExecutionHostId(worktree?.hostId)
  if (parsedWorktreeHost?.kind === 'runtime') {
    return parsedWorktreeHost.environmentId
  }
  if (parsedWorktreeHost?.kind === 'local') {
    return null
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoRecord(state.repos, repoId)
  if (!repo) {
    return null
  }
  // Why: session mirroring is expensive; a merely focused runtime must not make
  // legacy/local worktrees look remote-owned.
  return getExplicitRuntimeEnvironmentIdFromHost(getRepoExecutionHostId(repo))
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  if (!worktreeId) {
    return 'local'
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'local'
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExecutionHostIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const hasDetectedOwner = Object.values(state.detectedWorktreesByRepo ?? {}).some((result) =>
    result.worktrees.some((worktree) => worktree.id === worktreeId)
  )
  if (hasDetectedOwner) {
    const resolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
    if (resolution.kind === 'resolved') {
      return (
        resolution.route.executionHostId ??
        `runtime:${encodeURIComponent(resolution.route.runtimeEnvironmentId ?? 'unresolved-owner')}`
      )
    }
    // Why: conflicting detected publications must never enable paired-client-local PTY behavior.
    return 'runtime:unresolved-owner'
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, worktreeId)
  const worktreeHostId = getExecutionHostIdFromWorktreeHost(worktree?.hostId)
  if (worktreeHostId) {
    // Why: per-worktree host ownership is more specific than the repo host
    // default, especially when local and runtime checkouts share a project.
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoRecord(state.repos, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    return getRepoExecutionHostId(repo)
  }
  const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}

export function getSettingsForWorktreeRuntimeOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return {
    ...state.settings,
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}
