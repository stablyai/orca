import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  UNRESOLVED_OWNER_HOST_ID
} from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedRepoOwner as findRepoRecord,
  findIndexedWorktreeOwner as findWorktreeRecord,
  hasIndexedDetectedWorktree
} from './worktree-runtime-owner-index'
import { getActiveWorkspaceExecutionHostId } from './active-workspace-host'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import { isEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { getPairedWebClientEnvironmentId } from './paired-web-client-host'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import { namedHostForOwnerRef, resolveOwner, type WorkspaceOwnerRef } from './resolve-owner'
import { SELF_LOCAL_AUTHORITY, type HostAuthority } from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import { getFloatingWorkspaceOperationRoute } from './worktree-operation-route'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

function getExecutionHostIdFromWorktreeHost(
  hostId: string | null | undefined
): ExecutionHostId | null {
  return parseExecutionHostId(hostId)?.id ?? null
}

/** A row that names no host is this machine's: the client stamps every server row on arrival. */
function getUnstampedExecutionHostId(state: WorktreeRuntimeOwnerState): ExecutionHostId {
  const environmentId = getPairedWebClientEnvironmentId(state)
  return environmentId ? toRuntimeExecutionHostId(environmentId) : 'local'
}

/** Null means no row/stronger evidence names an owner; an existing hostless row positively means local. getExecutionHostIdForWorktree defaults silence to local for operation routing, which is unsafe as ownership evidence. */
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
    // Per-worktree ownership outranks repo defaults when local/runtime checkouts share a project.
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
  return getUnstampedExecutionHostId(state)
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  const known = getKnownExecutionHostIdForWorktree(state, worktreeId)
  if (known) {
    return known
  }
  // Why: a setup terminal has no row and spawns on the focused runtime (resolveTerminalHostOwnership).
  const setupEnvironmentId =
    worktreeId && isEphemeralSetupTerminalWorktreeId(worktreeId)
      ? getSingleFocusedRuntimeEnvironmentId(state)
      : null
  return setupEnvironmentId
    ? toRuntimeExecutionHostId(setupEnvironmentId)
    : getUnstampedExecutionHostId(state)
}

/**
 * {@link resolveOwner}, except an id no row places and no caller names a host resolves to this app
 * instead of `missing` — or, for a folder, to its saved session's server or a web client's only one.
 */
export function resolveOwnerOrLocal(
  state: WorktreeRuntimeOwnerState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  const match = resolveOwner(state, ref)
  if (match.kind !== 'missing' || namedHostForOwnerRef(state, ref)) {
    return match
  }
  const scope = parseWorkspaceKey(ref.workspaceId)
  const environmentId =
    scope?.type === 'folder'
      ? getRuntimeEnvironmentIdForFolderWorkspace(state, scope.folderWorkspaceId)
      : null
  return {
    kind: 'resolved',
    owner: environmentId
      ? { endpoint: { kind: 'environment', environmentId }, at: 'local' }
      : SELF_LOCAL_AUTHORITY
  }
}

/**
 * The paired server {@link resolveOwnerOrLocal} names, or `null` for this app, a directly dialed
 * SSH target or a twin. Unlike `runtimeEnvironmentIdUnlessTwin`, an unplaced folder on a web
 * client names that client's server.
 */
export function runtimeEnvironmentIdOrLocalUnlessTwin(
  state: WorktreeRuntimeOwnerState,
  workspaceId: string | null | undefined
): string | null {
  if (!workspaceId) {
    return null
  }
  const match = resolveOwnerOrLocal(state, { workspaceId })
  return match.kind === 'resolved' && match.owner.endpoint.kind === 'environment'
    ? match.owner.endpoint.environmentId
    : null
}
