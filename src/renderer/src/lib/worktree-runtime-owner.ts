import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedRepoOwner as findRepoRecord,
  findIndexedWorktreeOwner as findWorktreeRecord,
  hasIndexedDetectedWorktree,
  normalizeWorktreeLookupId,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import {
  getExecutionHostIdForFolderWorkspace,
  getExplicitRuntimeEnvironmentIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import {
  resolveActiveWorkspaceRoute,
  resolveExplicitWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResult
} from './worktree-operation-route'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
export type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
export { getRuntimeSessionMirrorEnvironmentIds } from './runtime-session-mirror-owners'

// Why: callers must distinguish an unresolved/contested owner from a local host.
const UNRESOLVED_WORKTREE_EXECUTION_HOST_ID: ExecutionHostId = 'runtime:unresolved-owner'

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

function getActiveWorkspaceExecutionHostId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): ExecutionHostId | null {
  return workspaceIdsMatch(state.activeWorktreeId, worktreeId)
    ? (state.activeWorkspaceExecutionHostId ?? null)
    : null
}

/** Active worktree state is usually raw while persisted/session callers may use
 * `worktree:<repo::path>`. Compare the two identity forms without accepting
 * malformed scoped keys as raw ids. */
function workspaceIdsMatch(left: string | null | undefined, right: string): boolean {
  if (!left) {
    return false
  }
  const leftScope = parseWorkspaceKey(left)
  const rightScope = parseWorkspaceKey(right)
  if (leftScope?.type === 'folder' || rightScope?.type === 'folder') {
    return (
      leftScope?.type === 'folder' &&
      rightScope?.type === 'folder' &&
      leftScope.folderWorkspaceId === rightScope.folderWorkspaceId
    )
  }
  const leftRaw = normalizeWorktreeLookupId(left)
  const rightRaw = normalizeWorktreeLookupId(right)
  return leftRaw !== null && rightRaw !== null && leftRaw === rightRaw
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
  const activeRoute = resolveActiveWorkspaceRoute(state, worktreeId)
  if (activeRoute) {
    return activeRoute.runtimeEnvironmentId
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getRuntimeEnvironmentIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return null
  }
  const indexedOwner = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  if (indexedOwner.kind === 'ambiguous') {
    return null
  }
  if (indexedOwner.kind === 'resolved') {
    const owner = indexedOwner.owner
    const projectedRuntimeOwner = getProjectedRuntimeOwnerEnvironmentId(owner)
    const parsedHost = parseExecutionHostId(owner.hostId)
    const hasDetectedOwner = hasIndexedDetectedWorktree(
      state.detectedWorktreesByRepo,
      rawWorktreeId
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
  const resolution = resolveWorktreeOperationRouteResult(state, rawWorktreeId)
  return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId : null
}

export function getExplicitRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const activeRoute = resolveActiveWorkspaceRoute(state, worktreeId)
  if (activeRoute) {
    return activeRoute.runtimeEnvironmentId
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExplicitRuntimeEnvironmentIdForFolderWorkspace(
      state,
      workspaceScope.folderWorkspaceId
    )
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return null
  }
  const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, rawWorktreeId)
  if (hasDetectedOwner) {
    // Why: detected-only rows are selectable before the primary catalog lands; use the same
    // ambiguity-aware explicit provenance as filesystem and terminal operations.
    const resolution = resolveExplicitWorktreeOperationRouteResult(state, rawWorktreeId)
    return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId : null
  }
  if (resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId).kind === 'ambiguous') {
    return null
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, rawWorktreeId)
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
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(rawWorktreeId)
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
  const activeHostId = getActiveWorkspaceExecutionHostId(state, worktreeId)
  if (activeHostId) {
    return activeHostId
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExecutionHostIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return UNRESOLVED_WORKTREE_EXECUTION_HOST_ID
  }
  const indexedOwner = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  // A duplicate id across physical hosts has no safe local fallback. Returning the
  // unresolved runtime sentinel keeps host-authority consumers fail-closed.
  if (indexedOwner.kind === 'ambiguous') {
    return UNRESOLVED_WORKTREE_EXECUTION_HOST_ID
  }
  const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, rawWorktreeId)
  if (hasDetectedOwner) {
    const resolution = resolveExplicitWorktreeOperationRouteResult(state, rawWorktreeId)
    if (resolution.kind === 'resolved') {
      return (
        resolution.route.executionHostId ??
        `runtime:${encodeURIComponent(resolution.route.runtimeEnvironmentId ?? 'unresolved-owner')}`
      )
    }
    // Why: conflicting detected publications must never enable paired-client-local PTY behavior.
    return UNRESOLVED_WORKTREE_EXECUTION_HOST_ID
  }
  const worktree = indexedOwner.kind === 'resolved' ? indexedOwner.owner : null
  const worktreeHostId = getExecutionHostIdFromWorktreeHost(worktree?.hostId)
  if (worktreeHostId) {
    // Why: per-worktree host ownership is more specific than the repo host
    // default, especially when local and runtime checkouts share a project.
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(rawWorktreeId)
  const repoResolution = resolveIndexedRepoOwner(state.repos, repoId)
  if (repoResolution.kind === 'ambiguous') {
    return UNRESOLVED_WORKTREE_EXECUTION_HOST_ID
  }
  const repo = repoResolution.kind === 'resolved' ? repoResolution.owner : null
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
