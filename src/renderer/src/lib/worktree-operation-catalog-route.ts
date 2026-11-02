// Resolve operation routes from worktree/detected rows and repos; owner disagreements remain ambiguous.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { addRoute, resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktrees,
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

function resolveCatalogRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  detected: readonly WorktreeOperationOwnerRecord[]
): WorktreeOperationRouteResolution {
  const exactRoutes = new Map<string, WorktreeOperationRoute>()
  const exactRepoIds = new Set<string>()
  const indexedWorktree = resolveIndexedWorktreeOwner(selectWorktreesByRepo(state), worktreeId)
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
  for (const worktree of detected) {
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
