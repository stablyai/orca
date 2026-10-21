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

/**
 * Owner rows for this id on one host, read from the repo catalog AND the detected-worktree index
 * because owner provenance is split across both stores — a HUB-projected owner may appear in
 * either one, and missing it would drop the transport the caller needs.
 */
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

/**
 * The active workspace's host selection is authoritative identity, but it carries no transport:
 * an `ssh:` host reached through a paired HUB names the target, not the HUB that proxies it. Keep
 * the selected host and recover the runtime owner from the matching owner rows (#11346).
 */
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

/**
 * Route an operation at the host the CALLER named rather than whichever host
 * the active workspace happens to select. `repoId::path` ids repeat across
 * hosts, so a destructive path that resolves host-blind can delete the same-id
 * workspace on the wrong machine (STA-4343); qualified callers resolve here.
 */
export function resolveWorktreeOperationRouteResultForHost(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeOperationRouteResolution {
  const host = parseExecutionHostId(executionHostId)
  // Why: an unparseable qualifier is not evidence of an owner — fail closed.
  return host ? resolveSelectedHostRoute(state, worktreeId, host) : { kind: 'missing' }
}

/**
 * `null`-returning adapter for host-qualified callers with no branch for `ambiguous` vs
 * `missing`. The fail-closed decision stays in the `*Result` resolver so the two entry
 * points can never disagree about what counts as an owner.
 */
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

/**
 * An authoritative host selection already names the target, so only the transport has to be
 * recovered — and only for `ssh:`, which a paired HUB can proxy. Rival HUBs projecting the same
 * host, or rows that contradict each other about its transport, are `ambiguous`: a transport-less
 * route would send the operation over this app's own SSH connection instead (review-5 #2).
 */
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

/**
 * Distinct execution hosts the store knows as owners of this id. More than one
 * means an unqualified destructive call cannot pick a target without guessing;
 * empty means no owner row carries host provenance (legacy hydration).
 */
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

/**
 * `null`-returning adapter over the owner-routed resolver for call sites that cannot act on
 * `ambiguous` — collapsing both refusals to `null` keeps them fail-closed at the call site.
 */
export function resolveWorktreeOperationRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

/**
 * Owner precedence for owner-routed operations: stamped identity first, the legacy
 * pre-owner-projection branches strictly below it, and an id no row can place fails closed —
 * defaulting an unplaceable id to `local` would aim the operation at the wrong machine.
 */
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
  // Why: folder workspaces are not Git worktrees — they never appear in the worktree/repo
  // catalogs scanned below, so without this branch a plain local folder workspace reads as an
  // unresolved cross-host identity and every owner-routed operation fails closed (#10251).
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

  // Why no Active Server focus here: the client stamps every server row on arrival, so an
  // unstamped row is never a server's.
  const savedRuntimeIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  // Why: a found repo/worktree record is positive identity evidence, so keep terminal-owner
  // parity with the folder branch below. Every stamped row already routed above, so an unstamped
  // repo row here is a legacy pre-owner-projection row — local by construction, as
  // getRepoExecutionHostId, main's resolveRepoOwnershipEvidence and Repo.executionHostId's own
  // contract all agree. Without this, the legacy hydration gates fail a genuinely local git
  // worktree closed whenever any unrelated runtime is saved — the #10251 symptom, for git
  // worktrees (#16733). A repo row on its own is repo identity, not worktree identity (#16841),
  // so a known worktree row — listed or currently detected — must back it.
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

/**
 * A local route for a worktree whose only repo rows predate owner projection — the exact
 * condition `resolveExplicitWorktreeOperationRouteResult` already routed above if it applied to
 * any row. Reaching this function means every row for `repoId` is unstamped, so
 * `getRepoExecutionHostId`'s own fallback resolves each of them to `local`; a row only has to
 * exist.
 */
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
    // Why: deleted/stale folder ids keep failing closed like unknown worktrees.
    return { kind: 'missing' }
  }
  // Why: a found folder record is positive identity evidence, so keep terminal-owner parity;
  // the worktree legacy hydration gates would fail local folders closed whenever unrelated
  // runtimes exist — the exact #10251 symptom.
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
