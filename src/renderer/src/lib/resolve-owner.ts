/**
 * The owner of a workspace as a {@link HostAuthority}, decided from the rows alone.
 */
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'
import {
  getRepoSshConnectionId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedWorktreeOwnerForHost,
  resolveQualifiedIndexedRepoOwnerForHost,
  findIndexedDetectedWorktrees,
  resolveIndexedFolderWorkspaceOwner,
  resolveIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'
import {
  hostAuthorityFromOperationRoute,
  SELF_LOCAL_AUTHORITY,
  type HostAuthority
} from '../../../shared/host-authority'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRouteResultForHost,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution,
  type WorktreeOperationRouteState
} from './worktree-operation-route'
import {
  getExplicitRuntimeEnvironmentIdForFolderWorkspace,
  getNestedSshTargetIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { warnAmbiguousOwnerOnce } from './ambiguous-owner-warning'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

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
  if (authority) {
    return { kind: 'resolved', owner: authority }
  }
  // An explicitly named host route is contested, not missing; missing could be read as this app.
  return resolution.route.executionHostId || resolution.route.runtimeEnvironmentId?.trim()
    ? { kind: 'ambiguous' }
    : { kind: 'missing' }
}

/** Detect folder/project twins before unqualified route lookups collapse them into missing/local ownership. */
function isFolderTwin(state: WorktreeOperationRouteState, folderWorkspaceId: string): boolean {
  const folder = resolveIndexedFolderWorkspaceOwner(
    selectFolderWorkspaces(state),
    folderWorkspaceId
  )
  if (folder.kind !== 'resolved') {
    return folder.kind === 'ambiguous'
  }
  // Folder host stamps/SSH connections prove ownership; only inherited host evidence is moot.
  return (
    !folder.owner.executionHostId?.trim() &&
    !folder.owner.connectionId?.trim() &&
    resolveIndexedProjectGroupOwner(state.projectGroups, folder.owner.projectGroupId).kind ===
      'ambiguous'
  )
}

/** The host the caller or the active workspace selection names for this workspace, if any. */
export function namedHostForOwnerRef(
  state: Pick<WorktreeOperationRouteState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  ref: WorkspaceOwnerRef
): ExecutionHostId | null {
  return (
    ref.hostId ??
    (state.activeWorktreeId === ref.workspaceId ? state.activeWorkspaceExecutionHostId : null) ??
    null
  )
}

export function resolveOwner(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): ExecutionHostOwnerMatch<HostAuthority> {
  if (getFloatingWorkspaceOperationRoute(ref.workspaceId)) {
    return { kind: 'resolved', owner: SELF_LOCAL_AUTHORITY }
  }
  const hostId = namedHostForOwnerRef(state, ref)
  const scope = parseWorkspaceKey(ref.workspaceId)
  // No host evidence can choose a twin; refuse rather than route to the wrong machine.
  if (!hostId && scope?.type === 'folder' && isFolderTwin(state, scope.folderWorkspaceId)) {
    return { kind: 'ambiguous' }
  }
  // Distinct servers proxying ssh:t must never collapse into directly dialed target ownership.
  const match = toOwnerMatch(
    hostId
      ? resolveWorktreeOperationRouteResultForHost(state, ref.workspaceId, hostId)
      : resolveWorktreeOperationRouteResult(state, ref.workspaceId)
  )
  return match.kind === 'resolved' ? withNestedPlace(state, ref, match.owner) : match
}

/** Server routes omit nested SSH; resolve connectionId from the owning folder/repo row, matching resolveWorktreeExecutionHost. */
function withNestedPlace(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef,
  authority: HostAuthority
): ExecutionHostOwnerMatch<HostAuthority> {
  if (authority.endpoint.kind !== 'environment' || authority.at !== 'local') {
    return { kind: 'resolved', owner: authority }
  }
  const scope = parseWorkspaceKey(ref.workspaceId)
  const targetId =
    scope?.type === 'folder'
      ? {
          kind: 'resolved' as const,
          owner: getNestedSshTargetIdForFolderWorkspace(state, scope.folderWorkspaceId, ref.hostId)
        }
      : nestedRepoTargetId(state, ref.workspaceId, authority.endpoint.environmentId)
  return targetId.kind === 'resolved'
    ? {
        kind: 'resolved',
        owner: targetId.owner
          ? { ...authority, at: toSshExecutionHostId(targetId.owner) }
          : authority
      }
    : targetId
}

function nestedRepoTargetId(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  environmentId: string
): ExecutionHostOwnerMatch<string | null> {
  const hostId = toRuntimeExecutionHostId(environmentId)
  const row = findIndexedWorktreeOwnerForHost(selectWorktreesByRepo(state), worktreeId, hostId)
  const physical = parseExecutionHostId(row?.hostId)
  if (physical?.kind === 'ssh') {
    return { kind: 'resolved', owner: physical.targetId }
  }
  const detected = findIndexedDetectedWorktrees(
    selectDetectedWorktreesByRepo(state),
    worktreeId
  ).filter(
    (candidate) =>
      candidate.runtimeOwnerEnvironmentId === environmentId || candidate.hostId === hostId
  )
  const targets = new Set(
    detected.map((candidate) => {
      const physical = parseExecutionHostId(candidate.hostId)
      return physical?.kind === 'ssh' ? physical.targetId : null
    })
  )
  if (targets.size === 0) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    let repo = resolveQualifiedIndexedRepoOwnerForHost(state.repos, repoId, hostId)
    if (repo.kind === 'ambiguous' && physical?.id === hostId) {
      repo = resolveQualifiedIndexedRepoOwnerForHost(state.repos, repoId, hostId, null)
    }
    if (repo.kind === 'ambiguous') {
      return repo
    }
    targets.add(repo.kind === 'resolved' ? getRepoSshConnectionId(repo.owner) : null)
  }
  return targets.size > 1
    ? { kind: 'ambiguous' }
    : { kind: 'resolved', owner: targets.values().next().value ?? null }
}

/** Two hosts publish this workspace (or contest it), so no host-routed action may pick one. */
export function isTwinWorkspace(
  state: WorktreeOperationRouteState,
  workspaceId: string | null | undefined
): boolean {
  return !!workspaceId && resolveOwner(state, { workspaceId }).kind === 'ambiguous'
}

/** Transport to the workspace's owner, or `null` when the rows name none or disagree. */
export function runtimeTargetForWorkspaceOwner(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): RuntimeClientTarget | null {
  const match = resolveOwner(state, ref)
  return match.kind === 'resolved' ? hostRouteForAuthority(match.owner).target : null
}

function restoredFolderEnvironmentId(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): string | null {
  const scope = parseWorkspaceKey(ref.workspaceId)
  return scope?.type === 'folder'
    ? getExplicitRuntimeEnvironmentIdForFolderWorkspace(state, scope.folderWorkspaceId)
    : null
}

export type RuntimeEnvironmentOwnerMatch =
  | { kind: 'resolved'; environmentId: string | null }
  | { kind: 'ambiguous' }

/**
 * The paired server that owns the workspace (`null` for this app or a directly dialed SSH target),
 * or `ambiguous` so mutating callers refuse instead of reading a twin as local.
 */
export function runtimeEnvironmentIdForWorkspaceOwner(
  state: WorktreeOperationRouteState,
  ref: WorkspaceOwnerRef
): RuntimeEnvironmentOwnerMatch {
  const match = resolveOwner(state, ref)
  switch (match.kind) {
    case 'ambiguous':
      return match
    case 'missing':
      // No server row normally means this app, except folder sessions can name a server before catalog hydration.
      return { kind: 'resolved', environmentId: restoredFolderEnvironmentId(state, ref) }
    case 'resolved': {
      const { endpoint } = match.owner
      switch (endpoint.kind) {
        case 'self':
          return { kind: 'resolved', environmentId: null }
        case 'environment':
          return { kind: 'resolved', environmentId: endpoint.environmentId }
      }
    }
  }
}

/** Resolve paired server, or null for local/direct SSH/twins, preserving main’s reader path. refusalAction logs ambiguous skipped writes once. */
export function runtimeEnvironmentIdUnlessTwin(
  state: WorktreeOperationRouteState,
  workspaceId: string | null | undefined,
  refusalAction?: string
): string | null {
  if (!workspaceId) {
    return null
  }
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  if (owner.kind === 'resolved') {
    return owner.environmentId
  }
  if (refusalAction) {
    warnAmbiguousOwnerOnce(workspaceId, refusalAction)
  }
  return null
}

/** A server route proven only by repo setup has no supporting worktree row. ssh:X and server connectionId X are different namespaces: reads/spawn can follow, but host writes may hit another machine with the same path. */
export function isUnprovenServerSshRoute(
  state: Pick<WorktreeOperationRouteState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  workspaceId: string,
  owner: HostAuthority
): boolean {
  const { endpoint, at } = owner
  if (
    endpoint.kind !== 'environment' ||
    at === 'local' ||
    parseWorkspaceKey(workspaceId)?.type === 'folder'
  ) {
    return false
  }
  return !someWorktreeCopy(
    state,
    workspaceId,
    (row) =>
      parseExecutionHostId(row.hostId)?.id === at &&
      row.runtimeOwnerEnvironmentId?.trim() === endpoint.environmentId
  )
}

type WorktreeCopy = { hostId?: string; runtimeOwnerEnvironmentId?: string }

/** Whether a listed or detected row with this worktree id satisfies `matches`. */
export function someWorktreeCopy(
  state: Pick<WorktreeOperationRouteState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string,
  matches: (row: WorktreeCopy) => boolean
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const copyMatches = (row: WorktreeCopy & { id: string }) => row.id === worktreeId && matches(row)
  return Boolean(
    selectWorktreesByRepo(state)?.[repoId]?.some(copyMatches) ||
    selectDetectedWorktreesByRepo(state)?.[repoId]?.worktrees.some(copyMatches)
  )
}
