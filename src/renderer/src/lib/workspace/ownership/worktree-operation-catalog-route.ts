// Resolve operation routes from worktree/detected rows and repos; owner disagreements remain ambiguous.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import { addOperationRoute, resolveFromCandidateRoutes } from './worktree-operation-route-focus'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktrees
} from './worktree-runtime-owner-index'
import { findIndexedRepoOwnerForHost, resolveIndexedRepoOwner } from './repo-owner-index'
// Type-only, so routing's shared vocabulary stays in one place without a runtime cycle.
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRoute,
  WorktreeOperationRouteResolution,
  WorktreeOperationRouteState
} from './worktree-operation-route'

const repoOperationRouteIndexCache = new WeakMap<
  NonNullable<WorktreeOperationRouteState['repos']>,
  {
    routes: ReadonlyMap<string, WorktreeOperationRouteResolution>
    sharedLocalProjects: ReadonlySet<string>
  }
>()
const explicitRouteIndexes = new WeakMap<
  readonly WorktreeOperationOwnerRecord[],
  {
    known: readonly WorktreeOperationOwnerRecord[]
    detected: readonly WorktreeOperationOwnerRecord[]
    repos: WorktreeOperationRouteState['repos']
    result: WorktreeOperationRouteResolution
  }
>()

export function resolveExplicitWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const known = findIndexedWorktrees(selectWorktreesByRepo(state), worktreeId)
  const detected = findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), worktreeId)
  const rows = known.length ? known : detected
  const cached = rows.length ? explicitRouteIndexes.get(rows) : undefined
  if (
    cached &&
    cached.known === known &&
    cached.detected === detected &&
    cached.repos === state.repos
  ) {
    return cached.result
  }
  const result = resolveCatalogRoute(state, worktreeId, detected)
  if (rows.length) {
    explicitRouteIndexes.set(rows, { known, detected, repos: state.repos, result })
  }
  return result
}

function collectOwnerRoutes(
  state: WorktreeOperationRouteState,
  owners: readonly WorktreeOperationOwnerRecord[],
  exactRoutes: Map<string, WorktreeOperationRoute>,
  exactRepoIds: Set<string>
): void {
  for (const worktree of owners) {
    exactRepoIds.add(worktree.repoId)
    const resolution = resolveRowRoute(state, worktree)
    if (resolution.kind === 'resolved') {
      addOperationRoute(exactRoutes, resolution.route)
    } else if (resolution.kind === 'ambiguous') {
      // Why: a bare SSH route stays ambiguous across hosts; focus may still pick one (#10491).
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

function resolveCatalogRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  detected: readonly WorktreeOperationOwnerRecord[]
): WorktreeOperationRouteResolution {
  const exactRoutes = new Map<string, WorktreeOperationRoute>()
  const exactRepoIds = new Set<string>()
  // Why: the owner index collapses rival hosts to ambiguous before focus can select one (#10491).
  collectOwnerRoutes(
    state,
    findIndexedWorktrees(selectWorktreesByRepo(state), worktreeId),
    exactRoutes,
    exactRepoIds
  )
  collectOwnerRoutes(state, detected, exactRoutes, exactRepoIds)
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
  return repoOperationIndex(state.repos)?.sharedLocalProjects.has(owner.repoId) ?? false
}

/** An unstamped record's host by the rules above: a shared local project's row is local, else its repo setup; with no setup, or one this app also has, the row was listed here (paired listings stamp ownership). */
export function resolveUnstampedRecordHost(
  state: WorktreeOperationRouteState,
  owner: WorktreeOperationOwnerRecord
): ExecutionHostId | null {
  if (isUnstampedRowOfSharedLocalProject(state, owner)) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const repo = resolveIndexedRepoOperationRoute(state.repos, owner.repoId)
  if (repo.kind === 'resolved') {
    return repo.route.executionHostId
  }
  return repo.kind === 'missing' ||
    findIndexedRepoOwnerForHost(state.repos, owner.repoId, LOCAL_EXECUTION_HOST_ID)
    ? LOCAL_EXECUTION_HOST_ID
    : null
}

function resolveIndexedRepoOperationRoute(
  repos: WorktreeOperationRouteState['repos'],
  repoId: string
): WorktreeOperationRouteResolution {
  return repoOperationIndex(repos)?.routes.get(repoId) ?? { kind: 'missing' }
}

function repoOperationIndex(repos: WorktreeOperationRouteState['repos']) {
  if (!repos) {
    return undefined
  }
  let index = repoOperationRouteIndexCache.get(repos)
  if (!index) {
    const next = new Map<string, WorktreeOperationRouteResolution>()
    const hostKinds = new Map<string, number>()
    for (const repo of repos) {
      const repoId = repo.id
      const hostId = getRepoExecutionHostId(repo)
      const kind =
        hostId === LOCAL_EXECUTION_HOST_ID
          ? 1
          : parseExecutionHostId(hostId)?.kind === 'runtime'
            ? 2
            : 4
      hostKinds.set(repoId, (hostKinds.get(repoId) ?? 0) | kind)
      if (!repo.executionHostId?.trim() && !repo.connectionId?.trim()) {
        continue
      }
      const route = routeForOwner({ hostId })
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
    index = {
      routes: next,
      sharedLocalProjects: new Set(
        [...hostKinds].filter(([, kinds]) => kinds === 3).map(([id]) => id)
      )
    }
    repoOperationRouteIndexCache.set(repos, index)
  }
  return index
}
