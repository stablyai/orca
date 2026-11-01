// Resolve operation routes from worktree/detected rows and repos; owner disagreements remain ambiguous.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { addRoute, resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import { addOperationRoute, resolveFromCandidateRoutes } from './worktree-operation-route-focus'
import { resolveIndexedRepoOwner } from './worktree-runtime-owner-index'
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

function collectOwnerRoutes(
  state: WorktreeOperationRouteState,
  owners: Iterable<WorktreeOperationOwnerRecord>,
  worktreeId: string,
  exactRoutes: Map<string, WorktreeOperationRoute>,
  exactRepoIds: Set<string>
): void {
  for (const worktree of owners) {
    if (worktree.id !== worktreeId) {
      continue
    }
    exactRepoIds.add(worktree.repoId)
    const resolution = resolveRowRoute(state, worktree)
    if (resolution.kind === 'resolved') {
      addOperationRoute(exactRoutes, resolution.route)
    } else if (resolution.kind === 'ambiguous') {
      // Why: bare SSH route when multi-host repo recovery stays ambiguous; focus may still pick.
      addOperationRoute(exactRoutes, routeForOwner(worktree))
    }
  }
}

function collectRepoOperationRoutes(
  repos: WorktreeOperationRouteState['repos'],
  repoId: string
): Map<string, WorktreeOperationRoute> {
  const routes = new Map<string, WorktreeOperationRoute>()
  if (!repos) {
    return routes
  }
  for (const repo of repos) {
    if (repo.id !== repoId) {
      continue
    }
    if (!repo.executionHostId?.trim() && !repo.connectionId?.trim()) {
      continue
    }
    addOperationRoute(routes, routeForOwner({ hostId: getRepoExecutionHostId(repo) }))
  }
  return routes
}

export function resolveExplicitWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const exactRoutes = new Map<string, WorktreeOperationRoute>()
  const exactRepoIds = new Set<string>()
  // Why: scan every projection so focus can select the unique active-host owner (#10491).
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    collectOwnerRoutes(state, worktrees, worktreeId, exactRoutes, exactRepoIds)
  }
  for (const result of Object.values(state.detectedWorktreesByRepo ?? {})) {
    collectOwnerRoutes(state, result.worktrees, worktreeId, exactRoutes, exactRepoIds)
  }
  if (exactRoutes.size > 0) {
    return resolveFromCandidateRoutes(exactRoutes, state.settings)
  }
  if (exactRepoIds.size === 0) {
    exactRepoIds.add(getRepoIdFromWorktreeId(worktreeId))
  }
  const repoRoutes = new Map<string, WorktreeOperationRoute>()
  for (const repoId of exactRepoIds) {
    const resolution = resolveIndexedRepoOperationRoute(state.repos, repoId)
    if (resolution.kind === 'resolved') {
      addOperationRoute(repoRoutes, resolution.route)
    } else if (resolution.kind === 'ambiguous') {
      for (const route of collectRepoOperationRoutes(state.repos, repoId).values()) {
        addOperationRoute(repoRoutes, route)
      }
    }
  }
  return resolveFromCandidateRoutes(repoRoutes, state.settings)
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

// Paired listings stamp ownership, so an unstamped project row was listed here. Otherwise a same-id server repo steals editor routing (#25467).
function isUnstampedRowOfSharedLocalProject(
  state: WorktreeOperationRouteState,
  owner: WorktreeOperationOwnerRecord
): boolean {
  // Indexed first: one row cannot be both, and retained selectors call this.
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
