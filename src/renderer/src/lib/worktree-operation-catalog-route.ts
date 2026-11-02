// Resolve operation routes from worktree/detected rows and repos; owner disagreements remain ambiguous.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { addRoute, resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  findIndexedRepoOwnerForHost,
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
  return sharedLocalProjectRepoIds(state.repos).has(owner.repoId)
}

const sharedLocalProjectIndexCache = new WeakMap<
  NonNullable<WorktreeOperationRouteState['repos']>,
  ReadonlySet<string>
>()

/** Repo ids with local and server setups and no SSH sibling (an SSH sibling keeps connection-owned routing); one pass per repo catalog. */
function sharedLocalProjectRepoIds(
  repos: WorktreeOperationRouteState['repos']
): ReadonlySet<string> {
  if (!repos) {
    return new Set()
  }
  let index = sharedLocalProjectIndexCache.get(repos)
  if (!index) {
    const kinds = new Map<string, Set<'local' | 'runtime' | 'other'>>()
    for (const repo of repos) {
      const hostId = getRepoExecutionHostId(repo)
      const kind =
        hostId === LOCAL_EXECUTION_HOST_ID
          ? 'local'
          : parseExecutionHostId(hostId)?.kind === 'runtime'
            ? 'runtime'
            : 'other'
      kinds.set(repo.id, (kinds.get(repo.id) ?? new Set()).add(kind))
    }
    index = new Set(
      [...kinds]
        .filter(([, seen]) => seen.has('local') && seen.has('runtime') && !seen.has('other'))
        .map(([repoId]) => repoId)
    )
    sharedLocalProjectIndexCache.set(repos, index)
  }
  return index
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
