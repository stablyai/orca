/**
 * The owner of a workspace as a {@link HostAuthority}, decided from the rows alone. It never reads
 * the "Active Server" focus setting; the one transitional path that does is
 * {@link resolveOwnerWithLegacyFocus}, which counts every answer focus changed.
 */
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  hostAuthorityFromOperationRoute,
  SELF_LOCAL_AUTHORITY,
  type HostAuthority
} from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import {
  getFloatingWorkspaceOperationRoute,
  resolveStrictWorktreeOperationRouteResultForHost,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

/** A worktree id, a `folder:` workspace key, or the floating workspace; `hostId` when the row names one. */
export type WorkspaceOwnerRef = { workspaceId: string; hostId?: ExecutionHostId }

function toOwnerMatch(
  resolution: WorktreeOperationRouteResolution
): ExecutionHostOwnerMatch<HostAuthority> {
  if (resolution.kind !== 'resolved') {
    return resolution
  }
  const authority = hostAuthorityFromOperationRoute(resolution.route)
  if (authority === 'contradictory') {
    return { kind: 'ambiguous' }
  }
  return authority ? { kind: 'resolved', owner: authority } : { kind: 'missing' }
}

function resolveRoute(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  if (getFloatingWorkspaceOperationRoute(ref.workspaceId)) {
    return { kind: 'resolved', owner: SELF_LOCAL_AUTHORITY }
  }
  // Why strict: rival servers proxying the same `ssh:t` must not read as a directly dialed target.
  return toOwnerMatch(
    ref.hostId
      ? resolveStrictWorktreeOperationRouteResultForHost(state, ref.workspaceId, ref.hostId)
      : resolveWorktreeOperationRouteResult(state, ref.workspaceId)
  )
}

export function resolveOwner(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  // Why: focus is the only settings field the route resolvers read; blanking it makes this focus-free.
  return resolveRoute({ ...state, settings: null }, ref)
}

let legacyFocusFallbackCount = 0

/** How many answers focus has changed since start; a slice drops its fallback once this stays 0. */
export function getLegacyFocusFallbackCount(): number {
  return legacyFocusFallbackCount
}

export function resetLegacyFocusFallbackCountForTest(): void {
  legacyFocusFallbackCount = 0
}

function sameOwnerMatch(
  a: ExecutionHostOwnerMatch<HostAuthority>,
  b: ExecutionHostOwnerMatch<HostAuthority>
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Today's routing answer, which still lets a single focused server claim rows that predate owner
 * stamping. Transitional: callers move to {@link resolveOwner} slice by slice.
 */
export function resolveOwnerWithLegacyFocus(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  const legacy = resolveRoute(state, ref)
  if (
    state.settings?.activeRuntimeEnvironmentId?.trim() &&
    !sameOwnerMatch(legacy, resolveOwner(state, ref))
  ) {
    legacyFocusFallbackCount += 1
  }
  return legacy
}
