import type {
  LinearConnectionStatus,
  LinearWorkspace,
  LinearViewer
} from '../../../../../shared/linear/workspace-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { linearStatus } from '@/runtime/runtime-linear-client'
import {
  getInflightStatusRequest,
  getLinearMutationGeneration,
  getLinearStatusReadGeneration,
  invalidateLinearCaches,
  evictLinearScopeCaches,
  isCurrentLinearStatusRead,
  nextLinearStatusReadGeneration,
  setInflightStatusRequest
} from './linear-slice-request-state'
import { linearStatusScopeSignature, withoutLinearAccountWorkspaces } from './linear-cache'
import {
  getLinearReadScope,
  isCurrentLinearRuntimeContext,
  type LinearReadScope
} from './linear-slice-scope'

export function publishLinearAccountStatus(
  set: LinearSliceSet,
  get: LinearSliceGet,
  scope: LinearReadScope,
  status: LinearConnectionStatus,
  affectedWorkspaceIds?: readonly string[]
): void {
  const previous = get().linearStatus
  const matching = get().linearStatusContextKey === scope.runtimeContextKey
  const changed =
    affectedWorkspaceIds !== undefined ||
    !matching ||
    linearStatusScopeSignature(previous) !== linearStatusScopeSignature(status)
  let affected = matching && affectedWorkspaceIds ? new Set(affectedWorkspaceIds) : undefined
  if (matching && previous.workspaces && status.workspaces) {
    const before = new Map(previous.workspaces.map((workspace) => [workspace.id, workspace]))
    const after = new Map(status.workspaces.map((workspace) => [workspace.id, workspace]))
    affected ??= new Set<string>()
    for (const [id, workspace] of before) {
      const next = after.get(id)
      if (
        !next ||
        next.credentialRevision !== workspace.credentialRevision ||
        next.organizationId !== workspace.organizationId
      ) {
        affected.add(id)
      }
    }
    for (const id of after.keys()) {
      if (!before.has(id)) {
        affected.add(id)
      }
    }
    if (
      (previous.selectedWorkspaceId ?? previous.activeWorkspaceId) !==
        (status.selectedWorkspaceId ?? status.activeWorkspaceId) ||
      previous.activeWorkspaceId !== status.activeWorkspaceId
    ) {
      affected.add('default')
      affected.add('selected')
    }
  }
  nextLinearStatusReadGeneration()
  const caches = changed ? evictLinearScopeCaches(get(), scope, affected) : {}
  set({
    ...(changed ? { linearStatus: status, ...caches } : {}),
    linearStatusObserved: true,
    linearStatusChecked: true,
    linearStatusContextKey: scope.runtimeContextKey
  })
  if (changed && (!affected || affected.size)) {
    invalidateLinearCaches(scope, affected)
  }
}

export function acknowledgeLinearAccount(
  set: LinearSliceSet,
  get: LinearSliceGet,
  scope: LinearReadScope,
  viewer: LinearViewer,
  workspace?: LinearWorkspace
): void {
  const previous =
    get().linearStatusContextKey === scope.runtimeContextKey ? get().linearStatus : null
  publishLinearAccountStatus(
    set,
    get,
    scope,
    {
      ...previous,
      connected: true,
      viewer,
      credentialError:
        workspace &&
        previous?.workspaces?.length === 1 &&
        previous.workspaces[0].id === workspace.id
          ? undefined
          : previous?.credentialError,
      ...(workspace
        ? {
            workspaces: [
              ...(previous?.workspaces ?? []).filter((item) => item.id !== workspace.id),
              workspace
            ],
            selectedWorkspaceId: workspace.id,
            activeWorkspaceId: workspace.id
          }
        : {})
    },
    workspace ? [workspace.id, 'default', 'selected'] : undefined
  )
}

export function removeLinearAccountWorkspaces(
  set: LinearSliceSet,
  get: LinearSliceGet,
  scope: LinearReadScope,
  workspaceIds: readonly string[]
): void {
  const previous = get().linearStatus
  if (get().linearStatusContextKey !== scope.runtimeContextKey || !previous.workspaces) {
    return
  }
  const status = withoutLinearAccountWorkspaces(previous, workspaceIds)
  if (status === previous) {
    return
  }
  setInflightStatusRequest(null)
  publishLinearAccountStatus(set, get, scope, status)
}

export function readLinearAccountStatus(
  set: LinearSliceSet,
  get: LinearSliceGet,
  scope: LinearReadScope,
  afterRead = true,
  force = false
): Promise<LinearConnectionStatus | null> {
  // An explicit source never dispatches or publishes through the focused default account.
  if (scope.explicitSource) {
    return scope.isCurrentRuntime()
      ? linearStatus(scope.settings).catch(() => null)
      : Promise.resolve(null)
  }
  const contextKey = scope.runtimeContextKey
  const existing = getInflightStatusRequest()
  if (existing?.contextKey === contextKey && !force && (!afterRead || existing.queued)) {
    return existing.promise
  }
  if (get().linearStatusContextKey !== contextKey && get().linearStatusChecked) {
    set({ linearStatusChecked: false })
  }
  const mutation = getLinearMutationGeneration()
  const generation = getLinearStatusReadGeneration()
  const current = () =>
    mutation === getLinearMutationGeneration() &&
    isCurrentLinearStatusRead(generation) &&
    isCurrentLinearRuntimeContext(contextKey, get().settings) &&
    getInflightStatusRequest() === request
  const dispatch = async () => {
    if (!current()) {
      if (getInflightStatusRequest() === request) {
        setInflightStatusRequest(null)
      }
      return null
    }
    request.queued = false
    try {
      const status = await linearStatus(scope.settings)
      if (!current()) {
        return null
      }
      publishLinearAccountStatus(set, get, scope, status)
      return status
    } catch {
      if (!current()) {
        return null
      }
      const matching = get().linearStatusContextKey === contextKey
      set({
        ...(matching
          ? {}
          : { linearStatus: { connected: false, viewer: null }, linearStatusObserved: false }),
        linearStatusChecked: true,
        linearStatusContextKey: contextKey
      })
      return null
    } finally {
      if (getInflightStatusRequest() === request) {
        setInflightStatusRequest(null)
      }
    }
  }
  // Reserve the existing slot before the immediate continuation can dispatch a cohort.
  const request = {
    contextKey,
    queued: afterRead,
    promise: Promise.resolve<LinearConnectionStatus | null>(null)
  }
  setInflightStatusRequest(request)
  request.promise = afterRead ? Promise.resolve().then(dispatch) : dispatch()
  return request.promise
}

export function createLinearStatusActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'checkLinearConnection'> {
  return {
    checkLinearConnection: async (force = false) => {
      await readLinearAccountStatus(set, get, getLinearReadScope(get().settings), false, force)
    }
  }
}
