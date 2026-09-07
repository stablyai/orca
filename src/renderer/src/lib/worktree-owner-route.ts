import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  WorktreeOperationOwnerRecord,
  WorktreeOperationRoute,
  WorktreeOperationRouteResolution,
  WorktreeOperationRouteState
} from './worktree-operation-route'

export function routeForOwner(owner: {
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}): WorktreeOperationRoute | null {
  const runtimeOwnerEnvironmentId = owner.runtimeOwnerEnvironmentId?.trim()
  if (!owner.hostId && !runtimeOwnerEnvironmentId) {
    return null
  }
  const parsedHost = parseExecutionHostId(owner.hostId)
  return {
    executionHostId: owner.hostId ?? null,
    runtimeEnvironmentId:
      runtimeOwnerEnvironmentId ||
      (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null)
  }
}

export function addRoute(
  routes: Map<string, WorktreeOperationRoute>,
  route: WorktreeOperationRoute | null
): void {
  if (!route) {
    return
  }
  routes.set(JSON.stringify(route), route)
}

function resolveRepoRouteForSshOwner(
  repos: WorktreeOperationRouteState['repos'],
  owner: WorktreeOperationOwnerRecord
): WorktreeOperationRouteResolution {
  if (!repos || !owner.hostId) {
    return { kind: 'missing' }
  }
  const routes = new Map<string, WorktreeOperationRoute>()
  for (const repo of repos) {
    if (repo.id !== owner.repoId) {
      continue
    }
    const connectionHostId = repo.connectionId ? toSshExecutionHostId(repo.connectionId) : null
    if (getRepoExecutionHostId(repo) !== owner.hostId && connectionHostId !== owner.hostId) {
      continue
    }
    addRoute(routes, routeForOwner({ hostId: getRepoExecutionHostId(repo) }))
  }
  const route = routes.values().next().value
  if (routes.size === 1 && route) {
    return { kind: 'resolved', route }
  }
  return routes.size > 1 ? { kind: 'ambiguous' } : { kind: 'missing' }
}

export function resolveExactWorktreeRoute(
  state: WorktreeOperationRouteState,
  owner: WorktreeOperationOwnerRecord
): WorktreeOperationRouteResolution {
  const route = routeForOwner(owner)
  if (!route) {
    return { kind: 'missing' }
  }
  if (route.runtimeEnvironmentId || parseExecutionHostId(route.executionHostId)?.kind !== 'ssh') {
    return { kind: 'resolved', route }
  }
  // Recover an optional HUB transport only from the repo setup matching the worktree's SSH host.
  const repoRoute = resolveRepoRouteForSshOwner(state.repos, owner)
  if (repoRoute.kind === 'ambiguous') {
    return repoRoute
  }
  if (repoRoute.kind === 'resolved' && repoRoute.route.runtimeEnvironmentId) {
    return {
      kind: 'resolved',
      route: { ...route, runtimeEnvironmentId: repoRoute.route.runtimeEnvironmentId }
    }
  }
  return { kind: 'resolved', route }
}
