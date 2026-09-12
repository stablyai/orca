/**
 * Owner-catalog half of worktree operation routing: resolve a route from the
 * worktree/detected-worktree rows and their repos, with any disagreement
 * between owners reported as `ambiguous` rather than silently picked.
 */
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { addRoute, resolveExactWorktreeRoute, routeForOwner } from './worktree-owner-route'
import {
  findIndexedDetectedWorktrees,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
// Type-only, so routing's shared vocabulary stays in one place without a runtime cycle.
import type {
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
    const resolution = resolveExactWorktreeRoute(state, indexedWorktree.owner)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind === 'resolved') {
      addRoute(exactRoutes, resolution.route)
    }
  }
  for (const worktree of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)) {
    exactRepoIds.add(worktree.repoId)
    const resolution = resolveExactWorktreeRoute(state, worktree)
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
