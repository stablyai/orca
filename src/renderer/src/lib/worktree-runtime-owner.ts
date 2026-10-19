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
  resolveIndexedProjectGroupOwner,
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
  namedHostForOwnerRef,
  resolveOwner,
  someWorktreeCopy,
  type WorkspaceOwnerRef
} from './resolve-owner'
import { SELF_LOCAL_AUTHORITY, type HostAuthority } from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import {
  getFloatingWorkspaceOperationRoute,
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

/**
 * The server the pre-`resolveOwner` resolver picked for a row that names no host (`null`: this
 * app or a twin). Only {@link resolveOwnerWithLegacyFallback} reads it, after a named host,
 * a twin and every stamped row have already been answered.
 */
function legacyRuntimeEnvironmentId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): string | null {
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
    // Why: a row on a web client that names no server is still reached through its only one.
    const onlyHost = getPairedWebClientEnvironmentId(state)
    if (!hasDetectedOwner && (projectedRuntimeOwner || parsedHost)) {
      return (
        projectedRuntimeOwner ||
        (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : onlyHost) ||
        null
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
          return (repoHost.kind === 'runtime' ? repoHost.environmentId : onlyHost) || null
        }
      }
    }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId || null : null
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

function hasRowHost(row: { executionHostId?: string | null; connectionId?: string | null }) {
  return Boolean(row.executionHostId?.trim() || row.connectionId?.trim())
}

/** Through the owner index: rows on two hosts always include a stamped one. */
function hasStampedRepoRow(state: WorktreeRuntimeOwnerState, repoId: string): boolean {
  const repo = resolveIndexedRepoOwner(state.repos, repoId)
  return repo.kind === 'ambiguous' || (repo.kind === 'resolved' && hasRowHost(repo.owner))
}

/** A row that names its host; without one the deprecated resolver's guess still applies. */
function hasHostEvidence(state: WorktreeRuntimeOwnerState, workspaceId: string): boolean {
  if (getFloatingWorkspaceOperationRoute(workspaceId)) {
    return true
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    if (!folder || hasRowHost(folder)) {
      return Boolean(folder)
    }
    const group = resolveIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
    return group.kind === 'ambiguous' || (group.kind === 'resolved' && hasRowHost(group.owner))
  }
  const repoId = getRepoIdFromWorktreeId(workspaceId)
  return (
    someWorktreeCopy(state, workspaceId, (row) =>
      Boolean(row.hostId?.trim() || row.runtimeOwnerEnvironmentId?.trim())
    ) || hasStampedRepoRow(state, repoId)
  )
}

/**
 * `resolveOwner` for callers folding off the deprecated resolvers: a named host and stamped rows
 * resolve as `resolveOwner` does (twins and contested hosts stay `ambiguous`), while `missing` and
 * rows with no host stamp keep the deprecated answer, single focused runtime included.
 */
export function resolveOwnerWithLegacyFallback(
  state: WorktreeRuntimeOwnerState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  const match = resolveOwner(state, ref)
  if (
    namedHostForOwnerRef(state, ref) ||
    match.kind === 'ambiguous' ||
    (match.kind === 'resolved' && hasHostEvidence(state, ref.workspaceId))
  ) {
    return match
  }
  const legacyEnvironmentId = legacyRuntimeEnvironmentId(state, ref.workspaceId)
  if (legacyEnvironmentId) {
    return {
      kind: 'resolved',
      owner: { endpoint: { kind: 'environment', environmentId: legacyEnvironmentId }, at: 'local' }
    }
  }
  return match.kind === 'resolved' ? match : { kind: 'resolved', owner: SELF_LOCAL_AUTHORITY }
}

/**
 * The paired server behind {@link resolveOwnerWithLegacyFallback}, or `null` for this app, a
 * directly dialed SSH target or a twin: for readers whose twin answer is "no server", as before.
 */
export function runtimeEnvironmentIdWithLegacyFallbackUnlessTwin(
  state: WorktreeRuntimeOwnerState,
  workspaceId: string | null | undefined
): string | null {
  if (!workspaceId) {
    return null
  }
  const match = resolveOwnerWithLegacyFallback(state, { workspaceId })
  return match.kind === 'resolved' && match.owner.endpoint.kind === 'environment'
    ? match.owner.endpoint.environmentId
    : null
}
