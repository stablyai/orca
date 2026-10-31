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

const sshRepoRouteIndexes = new WeakMap<
  NonNullable<WorktreeOperationRouteState['repos']>,
  ReadonlyMap<string, WorktreeOperationRouteResolution>
>()

function resolveRepoRouteForSshOwner(
  repos: WorktreeOperationRouteState['repos'],
  owner: WorktreeOperationOwnerRecord
): WorktreeOperationRouteResolution {
  if (!repos || !owner.hostId) {
    return { kind: 'missing' }
  }
  let index = sshRepoRouteIndexes.get(repos)
  if (!index) {
    const routesByHost = new Map<string, Map<string, WorktreeOperationRoute>>()
    for (const repo of repos) {
      const hostId = getRepoExecutionHostId(repo)
      const connectionHostId = repo.connectionId ? toSshExecutionHostId(repo.connectionId) : null
      for (const host of new Set([hostId, connectionHostId])) {
        if (!host) {
          continue
        }
        const key = `${repo.id}\0${host}`
        const routes = routesByHost.get(key) ?? new Map()
        addRoute(routes, routeForOwner({ hostId }))
        routesByHost.set(key, routes)
      }
    }
    const next = new Map<string, WorktreeOperationRouteResolution>()
    for (const [key, routes] of routesByHost) {
      const route = routes.values().next().value
      next.set(
        key,
        routes.size === 1 && route ? { kind: 'resolved', route } : { kind: 'ambiguous' }
      )
    }
    index = next
    sshRepoRouteIndexes.set(repos, index)
  }
  return index.get(`${owner.repoId}\0${owner.hostId}`) ?? { kind: 'missing' }
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
