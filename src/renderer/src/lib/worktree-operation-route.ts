import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { resolveExactWorktreeRoute } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  hasIndexedDetectedWorktree,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import { onPairedWebClientHost } from './paired-web-client-host'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  type FolderWorkspaceRuntimeOwnerState
} from './folder-workspace-runtime-owner'

export type WorktreeOperationRoute = {
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
}

/** The floating workspace has no host record; its files always live on this machine. */
export function getFloatingWorkspaceOperationRoute(
  worktreeId: string
): WorktreeOperationRoute | null {
  return worktreeId === FLOATING_TERMINAL_WORKTREE_ID
    ? { executionHostId: LOCAL_EXECUTION_HOST_ID, runtimeEnvironmentId: null }
    : null
}

export type WorktreeOperationRouteResolution =
  | { kind: 'resolved'; route: WorktreeOperationRoute }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

export type WorktreeOperationOwnerRecord = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

// settings/runtimeEnvironments come from FolderWorkspaceRuntimeOwnerState's legacy-owner base.
export type WorktreeOperationRouteState = FolderWorkspaceRuntimeOwnerState & {
  repos?: readonly Pick<AppState['repos'][number], 'id' | 'connectionId' | 'executionHostId'>[]
  worktreesByRepo?: Record<string, readonly WorktreeOperationOwnerRecord[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorktreeOperationOwnerRecord[] }>
  runtimeEnvironmentCatalogHydrated?: boolean
  removedRuntimeEnvironmentIds?: ReadonlySet<string>
}

/** Read repo AND detected catalogs: HUB owner provenance can be in either; missing it loses the required transport. */
function ownerRecordsOnHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationOwnerRecord[] {
  const owners: WorktreeOperationOwnerRecord[] = []
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      if (
        worktree.id === worktreeId &&
        parseExecutionHostId(worktree.hostId)?.id === executionHostId
      ) {
        owners.push(worktree)
      }
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    if (parseExecutionHostId(worktree.hostId)?.id === executionHostId) {
      owners.push(worktree)
    }
  }
  return owners
}

/** Active host selection proves identity, not transport. An SSH target can be proxied by a paired HUB; recover its runtime from matching owner rows (#11346). */
function resolveActiveWorkspaceRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution | null {
  const activeHost =
    state.activeWorktreeId === worktreeId
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  return activeHost ? resolveSelectedHostRoute(state, worktreeId, activeHost) : null
}

/** Honor the caller’s host qualifier: repoId::path repeats across hosts, so host-blind destructive routing can delete a twin on another machine (STA-4343). */
export function resolveWorktreeOperationRouteResultForHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRouteResolution {
  const host = parseExecutionHostId(executionHostId)
  // Why: an unparseable qualifier is not evidence of an owner — fail closed.
  return host ? resolveSelectedHostRoute(state, worktreeId, host) : { kind: 'missing' }
}

/** Null adapter for callers unable to distinguish ambiguous/missing; keep fail-closed policy in the Result resolver. */
export function resolveWorktreeOperationRouteForHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResultForHost(state, worktreeId, executionHostId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

/** A direct repo row backs a listing no row ties to a server, so a same-id proxy cannot claim it. */
function isDirectListing(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  hubOwners: { environmentIds: Set<string> }
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    hubOwners.environmentIds.size === 0 &&
    Boolean(
      state.repos?.some(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === executionHostId
      )
    )
  )
}

function collectHubOwnerEnvironmentIds(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): { environmentIds: Set<string>; hasAmbiguousOwner: boolean } {
  const environmentIds = new Set<string>()
  let hasAmbiguousOwner = false
  for (const owner of ownerRecordsOnHost(state, worktreeId, executionHostId)) {
    const resolution = resolveExactWorktreeRoute(state, owner)
    hasAmbiguousOwner ||= resolution.kind === 'ambiguous'
    if (resolution.kind === 'resolved' && resolution.route.runtimeEnvironmentId) {
      environmentIds.add(resolution.route.runtimeEnvironmentId)
    }
  }
  return { environmentIds, hasAmbiguousOwner }
}

// Authoritative SSH selection still needs HUB transport. Rival HUBs or contradictory transport rows remain ambiguous; dropping transport would use this app’s own SSH connection (review-5 #2).
function resolveSelectedHostRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  selectedHost: NonNullable<ReturnType<typeof parseExecutionHostId>>
): WorktreeOperationRouteResolution {
  if (selectedHost.kind === 'runtime') {
    return {
      kind: 'resolved',
      route: { executionHostId: selectedHost.id, runtimeEnvironmentId: selectedHost.environmentId }
    }
  }
  // Why: only an `ssh:` selection can hide a paired HUB owner, so local stays an O(1) hot path.
  if (selectedHost.kind !== 'ssh') {
    return {
      kind: 'resolved',
      route: onPairedWebClientHost(state, {
        executionHostId: selectedHost.id,
        runtimeEnvironmentId: null
      })
    }
  }
  const hubOwners = collectHubOwnerEnvironmentIds(state, worktreeId, selectedHost.id)
  if (
    hubOwners.environmentIds.size > 1 ||
    (hubOwners.hasAmbiguousOwner && !isDirectListing(state, worktreeId, selectedHost.id, hubOwners))
  ) {
    return { kind: 'ambiguous' }
  }
  return {
    kind: 'resolved',
    route: onPairedWebClientHost(state, {
      executionHostId: selectedHost.id,
      runtimeEnvironmentId: hubOwners.environmentIds.values().next().value ?? null
    })
  }
}

/** Known owner hosts: multiple makes unqualified destructive routing ambiguous; none means legacy hydration lacks provenance. */
export function getWorktreeOperationOwnerHostIds(
  state: WorktreeOperationRouteState,
  worktreeId: string
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      const hostId = worktree.id === worktreeId ? parseExecutionHostId(worktree.hostId)?.id : null
      if (hostId) {
        hostIds.add(hostId)
      }
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    const hostId = parseExecutionHostId(worktree.hostId)?.id
    if (hostId) {
      hostIds.add(hostId)
    }
  }
  return [...hostIds]
}

/** Collapse ambiguous/missing to null for callers unable to act on either, preserving fail-closed behavior. */
export function resolveWorktreeOperationRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

/** Prefer stamped identity over legacy hydration branches; unknown IDs fail closed because default-local can target the wrong machine. */
export function resolveWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const resolution = resolveOwnerRouteResult(state, worktreeId)
  return resolution.kind === 'resolved'
    ? { kind: 'resolved', route: onPairedWebClientHost(state, resolution.route) }
    : resolution
}

function resolveOwnerRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const activeResolution = resolveActiveWorkspaceRouteResult(state, worktreeId)
  if (activeResolution) {
    return activeResolution
  }
  // Folders never appear in worktree/repo catalogs; resolve their own records or local folders fail closed as unknown cross-host IDs (#10251).
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return resolveFolderWorkspaceOperationRoute(state, workspaceScope.folderWorkspaceId)
  }
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind !== 'missing') {
    return explicitResolution
  }

  const hasDetectedWorktree = hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId)
  const hasKnownWorktree =
    resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId).kind !== 'missing' ||
    hasDetectedWorktree
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hasKnownRepo = resolveIndexedRepoOwner(state.repos, repoId).kind !== 'missing'
  if (!hasKnownWorktree && !hasKnownRepo) {
    return { kind: 'missing' }
  }

  // Every server row is stamped on arrival; focus cannot make an unstamped row remote.
  const savedRuntimeIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  // A listed/detected worktree backed by an unstamped repo proves local identity, matching folder routing despite unrelated saved runtimes (#16733). Stamped rows routed above; a repo alone proves no worktree exists (#16841).
  const localOwnerRoute = hasKnownWorktree
    ? resolveUnstampedLocalWorktreeRoute(state, repoId)
    : null
  if (localOwnerRoute) {
    return { kind: 'resolved', route: localOwnerRoute }
  }
  // Why: no saved runtime can publish a remote ownerless row; otherwise current detected presence affirms identity under the stamped-writer invariant.
  const mayBeLegacyLocal =
    savedRuntimeIds === undefined ||
    (state.runtimeEnvironmentCatalogHydrated === true &&
      (savedRuntimeIds.length === 0 || hasDetectedWorktree))
  return mayBeLegacyLocal
    ? {
        kind: 'resolved',
        route: { executionHostId: LOCAL_EXECUTION_HOST_ID, runtimeEnvironmentId: null }
      }
    : { kind: 'missing' }
}

/** All repo rows reaching here predate owner projection (stamped rows routed above), so getRepoExecutionHostId resolves any existing row local. */
function resolveUnstampedLocalWorktreeRoute(
  state: WorktreeOperationRouteState,
  repoId: string
): WorktreeOperationRoute | null {
  const hasUnstampedRepoRow = resolveIndexedRepoOwner(state.repos, repoId).kind !== 'missing'
  return hasUnstampedRepoRow
    ? { executionHostId: LOCAL_EXECUTION_HOST_ID, runtimeEnvironmentId: null }
    : null
}

/**
 * Folder workspaces have no repo or worktree rows, so they route off their own owner record
 * instead of the legacy hydration gates above.
 */
function resolveFolderWorkspaceOperationRoute(
  state: WorktreeOperationRouteState,
  folderWorkspaceId: string
): WorktreeOperationRouteResolution {
  if (!findFolderWorkspaceOwner(state, folderWorkspaceId)) {
    // Deleted/stale folder IDs fail closed like unknown worktrees.
    return { kind: 'missing' }
  }
  // A found folder proves identity; unrelated saved runtimes must not fail it closed (#10251).
  const executionHostId = getExecutionHostIdForFolderWorkspace(state, folderWorkspaceId)
  const parsedHost = parseExecutionHostId(executionHostId)
  return {
    kind: 'resolved',
    route: {
      executionHostId,
      runtimeEnvironmentId: parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
    }
  }
}
