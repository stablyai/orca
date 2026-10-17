import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  UNRESOLVED_OWNER_HOST_ID
} from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedRepoOwner as findRepoRecord,
  findIndexedWorktreeOwner as findWorktreeRecord,
  hasIndexedDetectedWorktree,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import { getPairedWebClientEnvironmentId } from './paired-web-client-host'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import {
  getFloatingWorkspaceOperationRoute,
  resolveActiveWorkspaceRoute,
  resolveWorktreeOperationRouteResult
} from './worktree-operation-route'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

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

export type WorktreeRuntimeOwner =
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'non-runtime' }
  // Why: the same repo id and path is published by two hosts (e.g. mid ssh-to-runtime migration).
  | { kind: 'ambiguous' }

const NON_RUNTIME_OWNER: WorktreeRuntimeOwner = { kind: 'non-runtime' }
const AMBIGUOUS_OWNER: WorktreeRuntimeOwner = { kind: 'ambiguous' }

function toRuntimeOwner(environmentId: string | null | undefined): WorktreeRuntimeOwner {
  return environmentId ? { kind: 'runtime', environmentId } : NON_RUNTIME_OWNER
}

/**
 * @deprecated Use `resolveOwner` (`./resolve-owner`), which keeps the host and reports twins as
 * `ambiguous`. Here ambiguous collapses to `null`, which callers read as local; read-only use only.
 */
export function getRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  const owner = resolveRuntimeOwnerForWorktree(state, worktreeId)
  return owner.kind === 'runtime' ? owner.environmentId : null
}

/**
 * @deprecated Use `resolveOwner` (`./resolve-owner`). This drops the host, reads local, SSH and
 * unknown alike as `non-runtime`, and sends folder twins to the focused runtime.
 */
export function resolveRuntimeOwnerForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): WorktreeRuntimeOwner {
  if (!worktreeId) {
    return NON_RUNTIME_OWNER
  }
  const floatingRoute = getFloatingWorkspaceOperationRoute(worktreeId)
  if (floatingRoute) {
    return toRuntimeOwner(floatingRoute.runtimeEnvironmentId)
  }
  const activeRoute = resolveActiveWorkspaceRoute(state, worktreeId)
  if (activeRoute) {
    return toRuntimeOwner(activeRoute.runtimeEnvironmentId)
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return toRuntimeOwner(
      getRuntimeEnvironmentIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
    )
  }
  const indexedOwner = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (indexedOwner.kind === 'ambiguous') {
    return AMBIGUOUS_OWNER
  }
  if (indexedOwner.kind === 'resolved') {
    const owner = indexedOwner.owner
    const projectedRuntimeOwner = getProjectedRuntimeOwnerEnvironmentId(owner)
    const parsedHost = parseExecutionHostId(owner.hostId)
    const hasDetectedOwner = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
    // Why: a row on a web client that names no server is still reached through its only one.
    const onlyHost = getPairedWebClientEnvironmentId(state)
    if (!hasDetectedOwner && (projectedRuntimeOwner || parsedHost)) {
      return toRuntimeOwner(
        projectedRuntimeOwner ||
          (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : onlyHost)
      )
    }
    if (!hasDetectedOwner) {
      const repoResolution = resolveIndexedRepoOwner(state.repos, owner.repoId)
      if (repoResolution.kind === 'ambiguous') {
        return AMBIGUOUS_OWNER
      }
      if (
        repoResolution.kind === 'resolved' &&
        (repoResolution.owner.executionHostId?.trim() || repoResolution.owner.connectionId?.trim())
      ) {
        const repoHost = parseExecutionHostId(getRepoExecutionHostId(repoResolution.owner))
        if (repoHost) {
          return toRuntimeOwner(repoHost.kind === 'runtime' ? repoHost.environmentId : onlyHost)
        }
      }
    }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'ambiguous') {
    return AMBIGUOUS_OWNER
  }
  return resolution.kind === 'resolved'
    ? toRuntimeOwner(resolution.route.runtimeEnvironmentId)
    : NON_RUNTIME_OWNER
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
  const floatingRoute = getFloatingWorkspaceOperationRoute(worktreeId)
  if (floatingRoute) {
    return floatingRoute.executionHostId
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
        (resolution.route.runtimeEnvironmentId
          ? toRuntimeExecutionHostId(resolution.route.runtimeEnvironmentId)
          : UNRESOLVED_OWNER_HOST_ID)
      )
    }
    // Why: conflicting detected publications must never enable paired-client-local PTY behavior.
    return UNRESOLVED_OWNER_HOST_ID
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
