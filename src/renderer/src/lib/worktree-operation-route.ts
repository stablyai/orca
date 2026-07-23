import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { resolveIndexedWorktreeOwner } from './worktree-runtime-owner-index'

export type WorktreeOperationRoute = {
  executionHostId: ExecutionHostId | null
  runtimeEnvironmentId: string | null
}

export type WorktreeOperationRouteResolution =
  | { kind: 'resolved'; route: WorktreeOperationRoute }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

type WorktreeOperationOwnerRecord = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

type WorktreeOperationRouteState = {
  repos?: readonly Pick<AppState['repos'][number], 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<NonNullable<AppState['settings']>, 'activeRuntimeEnvironmentId'> | null
  worktreesByRepo?: Record<string, readonly WorktreeOperationOwnerRecord[]>
  detectedWorktreesByRepo?: Record<string, { worktrees: readonly WorktreeOperationOwnerRecord[] }>
  runtimeEnvironments?: readonly { id: string }[]
  runtimeEnvironmentCatalogHydrated?: boolean
  removedRuntimeEnvironmentIds?: ReadonlySet<string>
}

const repoOperationRouteIndexCache = new WeakMap<
  NonNullable<WorktreeOperationRouteState['repos']>,
  ReadonlyMap<string, WorktreeOperationRouteResolution>
>()

function routeForOwner(owner: {
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

function addRoute(
  routes: Map<string, WorktreeOperationRoute>,
  route: WorktreeOperationRoute | null
): void {
  if (!route) {
    return
  }
  routes.set(JSON.stringify(route), route)
}

function resolveExactWorktreeRoute(
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
  const repoRoute = resolveIndexedRepoOperationRoute(state.repos, owner.repoId)
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

export function resolveWorktreeOperationRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

export function resolveWorktreeOperationRouteResult(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind !== 'missing') {
    return explicitResolution
  }

  const hasKnownWorktree =
    Object.values(state.worktreesByRepo ?? {}).some((worktrees) =>
      worktrees.some((worktree) => worktree.id === worktreeId)
    ) ||
    Object.values(state.detectedWorktreesByRepo ?? {}).some((result) =>
      result.worktrees.some((worktree) => worktree.id === worktreeId)
    )
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hasKnownRepo = state.repos?.some((repo) => repo.id === repoId) === true
  if (!hasKnownWorktree && !hasKnownRepo) {
    return { kind: 'missing' }
  }

  // Why: pre-owner-projection runtimes published no host fields; terminal routing retains their single focused-runtime behavior.
  const legacyRuntimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  const savedRuntimeIds = state.runtimeEnvironments?.map((environment) => environment.id.trim())
  const legacyRuntimeIsUnambiguous =
    savedRuntimeIds === undefined ||
    (savedRuntimeIds.length === 1 && savedRuntimeIds[0] === legacyRuntimeEnvironmentId)
  if (legacyRuntimeEnvironmentId && !legacyRuntimeIsUnambiguous) {
    return { kind: 'missing' }
  }
  if (legacyRuntimeEnvironmentId) {
    return {
      kind: 'resolved',
      route: {
        executionHostId: `runtime:${encodeURIComponent(legacyRuntimeEnvironmentId)}`,
        runtimeEnvironmentId: legacyRuntimeEnvironmentId
      }
    }
  }
  const mayBeLegacyLocal =
    (savedRuntimeIds === undefined ||
      (state.runtimeEnvironmentCatalogHydrated === true && savedRuntimeIds.length === 0)) &&
    (state.removedRuntimeEnvironmentIds?.size ?? 0) === 0
  return mayBeLegacyLocal
    ? { kind: 'resolved', route: { executionHostId: 'local', runtimeEnvironmentId: null } }
    : { kind: 'missing' }
}

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
  for (const result of Object.values(state.detectedWorktreesByRepo ?? {})) {
    for (const worktree of result.worktrees) {
      if (worktree.id === worktreeId) {
        exactRepoIds.add(worktree.repoId)
        const resolution = resolveExactWorktreeRoute(state, worktree)
        if (resolution.kind === 'ambiguous') {
          return resolution
        }
        if (resolution.kind === 'resolved') {
          addRoute(exactRoutes, resolution.route)
        }
      }
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

export function settingsForWorktreeOperationRoute(
  settings: AppState['settings'],
  route: WorktreeOperationRoute
): AppState['settings'] {
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: route.runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: route.runtimeEnvironmentId } as AppState['settings'])
}
