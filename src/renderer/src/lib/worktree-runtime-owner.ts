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
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import {
  findFolderWorkspaceOwner,
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
  return state.activeWorktreeId === worktreeId
    ? (state.activeWorkspaceExecutionHostId ?? null)
    : null
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
  const indexedOwner = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (indexedOwner.kind === 'ambiguous') {
    return null
  }
  if (indexedOwner.kind === 'resolved') {
    const owner = indexedOwner.owner
    const projectedRuntimeOwner = getProjectedRuntimeOwnerEnvironmentId(owner)
    const parsedHost = parseExecutionHostId(owner.hostId)
    const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
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
  const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
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

function getFocusedRuntimeOrLocalExecutionHostId(
  state: WorktreeRuntimeOwnerState
): ExecutionHostId {
  const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}

/**
 * The catalog's answer, or `null` when it has none: no row names an owner for this worktree (a git
 * worktree without a repo row, a folder workspace without a folder-workspace row) and nothing more
 * specific — active-workspace host, detected owner, per-worktree host — applies either. A row that
 * exists and names no owner is a positive `'local'`; a row that has not landed is silence.
 * {@link getExecutionHostIdForWorktree} papers over that silence with the focused-runtime-or-local
 * default, which is the right answer for routing an operation and the wrong one for a caller that
 * reads the host as evidence.
 */
export function getKnownExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId | null {
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
    const hostId = getExecutionHostIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
    // Why: the folder resolver substitutes `'local'` for a missing row the same way this one does.
    return hostId === 'local' && !findFolderWorkspaceOwner(state, workspaceScope.folderWorkspaceId)
      ? null
      : hostId
  }
  const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
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
  if (!repo) {
    return null
  }
  const hasExplicitOwner = Boolean(repo.executionHostId?.trim() || repo.connectionId?.trim())
  if (hasExplicitOwner) {
    return getRepoExecutionHostId(repo)
  }
  return getFocusedRuntimeOrLocalExecutionHostId(state)
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  return (
    getKnownExecutionHostIdForWorktree(state, worktreeId) ??
    getFocusedRuntimeOrLocalExecutionHostId(state)
  )
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
