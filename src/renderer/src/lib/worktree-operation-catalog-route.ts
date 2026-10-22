/**
 * Owner-catalog half of worktree operation routing: resolve a route from the
 * worktree/detected-worktree rows and their repos, with any disagreement
 * between owners reported as `ambiguous` rather than silently picked.
 */
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { addRoute, resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
// Type-only, so routing's shared vocabulary stays in one place without a runtime cycle.
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRoute,
  WorktreeOperationRouteResolution,
  WorktreeOperationRouteState
} from './worktree-operation-route'

const repoOperationRouteIndexCache = new WeakMap<
  NonNullable<WorktreeOperationRouteState['repos']>,
  ReadonlyMap<string, WorktreeOperationRouteResolution>
>()

export function resolveExplicitWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const exactRoutes = new Map<string, WorktreeOperationRoute>()
  const exactRepoIds = new Set<string>()
  const indexedWorktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (indexedWorktree.kind === 'ambiguous') {
    return { kind: 'ambiguous' }
  }
  if (indexedWorktree.kind === 'resolved') {
    exactRepoIds.add(indexedWorktree.owner.repoId)
    const resolution = resolveRowRoute(state, indexedWorktree.owner)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind === 'resolved') {
      addRoute(exactRoutes, resolution.route)
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    exactRepoIds.add(worktree.repoId)
    const resolution = resolveRowRoute(state, worktree)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind === 'resolved') {
      addRoute(exactRoutes, resolution.route)
    }
  }
  if (exactRoutes.size > 0) {
    const route = exactRoutes.values().next().value
    return exactRoutes.size === 1 && route ? { kind: 'resolved', route } : { kind: 'ambiguous' }
  }
  if (exactRepoIds.size === 0) {
    exactRepoIds.add(getRepoIdFromWorktreeId(worktreeId))
  }
  const repoRoutes = new Map<string, WorktreeOperationRoute>()
  for (const repoId of exactRepoIds) {
    const resolution = resolveIndexedRepoOperationRoute(state.repos, repoId)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind === 'resolved') {
      addRoute(repoRoutes, resolution.route)
    }
  }
  const route = repoRoutes.values().next().value
  if (repoRoutes.size === 1 && route) {
    return { kind: 'resolved', route }
  }
  if (repoRoutes.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'missing' }
}

const LOCAL_ROUTE: WorktreeOperationRoute = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  runtimeEnvironmentId: null
}

function resolveRowRoute(
  state: WorktreeOperationRouteState,
  owner: WorktreeOperationOwnerRecord
): WorktreeOperationRouteResolution {
  const resolution = resolveExactWorktreeRoute(state, owner)
  return resolution.kind === 'missing' && isUnstampedRowOfSharedLocalProject(state, owner)
    ? { kind: 'resolved', route: LOCAL_ROUTE }
    : resolution
}

/**
 * Listings stamp every paired-server row with its host (withRepoHostOwnership), so an unstamped row
 * of a project set up both here and on a paired server was listed here. Without this the project's
 * repo rows disagree and an editor tab falls through to the focused server (#25467).
 */
function isUnstampedRowOfSharedLocalProject(
  state: WorktreeOperationRouteState,
  owner: WorktreeOperationOwnerRecord
): boolean {
  // Why the index first: one row cannot be both, and this runs inside retained selectors.
  if (
    owner.hostId ||
    owner.runtimeOwnerEnvironmentId?.trim() ||
    resolveIndexedRepoOwner(state.repos, owner.repoId).kind !== 'ambiguous'
  ) {
    return false
  }
  let hasLocalRepoRow = false
  let hasRuntimeRepoRow = false
  for (const repo of state.repos ?? []) {
    if (repo.id !== owner.repoId) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      hasLocalRepoRow = true
    } else if (parseExecutionHostId(hostId)?.kind === 'runtime') {
      hasRuntimeRepoRow = true
    } else {
      // Why: an SSH sibling keeps the existing connection-owned routing.
      return false
    }
  }
  return hasLocalRepoRow && hasRuntimeRepoRow
}

function resolveIndexedRepoOperationRoute(
  repos: WorktreeOperationRouteState['repos'],
  repoId: string
): WorktreeOperationRouteResolution {
  if (!repos) {
    return { kind: 'missing' }
  }
  let index = repoOperationRouteIndexCache.get(repos)
  if (!index) {
    const next = new Map<string, WorktreeOperationRouteResolution>()
    for (const repo of repos) {
      const repoId = repo.id
      if (!repo.executionHostId?.trim() && !repo.connectionId?.trim()) {
        continue
      }
      const route = routeForOwner({ hostId: getRepoExecutionHostId(repo) })
      if (!route) {
        continue
      }
      const current = next.get(repoId)
      if (!current) {
        next.set(repoId, { kind: 'resolved', route })
      } else if (
        current.kind === 'resolved' &&
        JSON.stringify(current.route) !== JSON.stringify(route)
      ) {
        next.set(repoId, { kind: 'ambiguous' })
      }
    }
    index = next
    repoOperationRouteIndexCache.set(repos, index)
  }
  return index.get(repoId) ?? { kind: 'missing' }
}
