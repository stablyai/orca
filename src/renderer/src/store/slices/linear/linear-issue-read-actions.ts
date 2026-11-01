import type { LinearIssueData, LinearIssueRequest } from './linear-issue-publication'
import { openLinearIssueRead } from './linear-issue-publication'
import {
  canPublishLinearScopeCache,
  isCurrentLinearRuntimeContext,
  type LinearReadScope
} from './linear-slice-scope'
import {
  readLinearAccountStatus,
  removeLinearAccountWorkspaces
} from './linear-slice-status-actions'
import type { LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { isFresh, linearReadAccountRejections } from './linear-cache'
import type { CacheEntry } from '../../github/cache-model'

export function openStoreLinearIssueRead<T extends LinearIssueData>(args: {
  scope: LinearReadScope
  key: string
  workspaceId?: string | null
  identifier?: string
  requests: Map<string, LinearIssueRequest<T>>
  cached: CacheEntry<T> | undefined
  seed?: T
  force?: boolean
  set: LinearSliceSet
  get: LinearSliceGet
  dispatch: (force: boolean) => Promise<T>
  publish: (data: T) => void
}): LinearIssueRequest<T> {
  const { scope, requests, key, get } = args
  const expose = (read: LinearIssueRequest<T>): LinearIssueRequest<T> => ({
    ...read,
    acquire: (isLive = () => true) =>
      read.acquire(
        () =>
          isLive() &&
          (scope.explicitSource ||
            isCurrentLinearRuntimeContext(scope.runtimeContextKey, get().settings))
      )
  })
  const requestKey = JSON.stringify([scope.contextKey, key])
  const existing = requests.get(requestKey)
  if (existing?.contextKey === scope.contextKey) {
    if (args.force) {
      existing.force()
    }
    return expose(existing)
  }
  existing?.abandon()
  let read: LinearIssueRequest<T> | undefined
  read = openLinearIssueRead<T>({
    scope,
    workspaceId: args.workspaceId,
    identifier: args.identifier,
    workspaces:
      get().linearStatusContextKey === scope.runtimeContextKey ||
      (!scope.explicitSource && !get().linearStatusContextKey)
        ? get().linearStatus.workspaces
        : undefined,
    seed:
      args.seed ??
      (canPublishLinearScopeCache(scope, get().settings) ? (args.cached?.data ?? null) : null),
    cached:
      !args.force &&
      canPublishLinearScopeCache(scope, get().settings) &&
      args.cached &&
      isFresh(args.cached)
        ? (args.seed ?? args.cached.data)
        : undefined,
    dispatch: args.dispatch,
    publish: (data) => {
      if (canPublishLinearScopeCache(scope, get().settings)) {
        args.publish(data)
      }
    },
    isCurrent: () => scope.isCurrentRuntime() && (!read || requests.get(requestKey) === read),
    remove: () => {
      if (requests.get(requestKey) === read) {
        requests.delete(requestKey)
      }
    },
    onSettled: (data, error) => {
      if (scope.explicitSource || !canPublishLinearScopeCache(scope, get().settings)) {
        return
      }
      const rejected = linearReadAccountRejections(
        data,
        error,
        args.workspaceId,
        get().linearStatus,
        scope.settings
      )
      if (rejected === null) {
        return
      }
      if (rejected.length) {
        removeLinearAccountWorkspaces(args.set, get, scope, rejected)
      }
      void readLinearAccountStatus(args.set, get, scope)
    }
  })
  requests.set(requestKey, read)
  return expose(read)
}
