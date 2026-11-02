import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../../../shared/integration-credential-errors'
import { linearListIssues, linearSearchIssues } from '@/runtime/runtime-linear-client'
import {
  evictStaleEntries,
  getSelectedWorkspaceId,
  linearListCacheKey,
  linearSearchCacheKey
} from './linear-cache'
import { inflightListRequests, inflightSearchRequests } from './linear-slice-request-state'
import {
  getLinearReadScope,
  normalizeListAttributeFilter,
  scopedLinearCacheKey
} from './linear-slice-scope'
import { openStoreLinearIssueRead } from './linear-issue-read-actions'

function throwReadError(error: unknown): never {
  console.warn('[linear] issue read failed:', error)
  if (isIntegrationCredentialDecryptionError(error)) {
    throw new Error(credentialDecryptionMessage('Linear'))
  }
  throw error
}

export function retainFailedWorkspaceIssues(
  result: LinearCollectionResult<LinearIssue>,
  cached: LinearIssue[],
  workspaceId?: string | null
): LinearCollectionResult<LinearIssue> {
  if (!result.errors?.length) {
    return result
  }
  const failed = new Set(result.errors.map((error) => error.workspaceId))
  const returned = new Set(result.items.map((item) => JSON.stringify([item.workspaceId, item.id])))
  return {
    ...result,
    items: [
      ...result.items,
      ...cached.filter(
        (issue) =>
          failed.has(issue.workspaceId ?? workspaceId ?? '') &&
          !returned.has(JSON.stringify([issue.workspaceId, issue.id]))
      )
    ]
  }
}

export function createLinearIssueListActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'searchLinearIssues' | 'listLinearIssues'> {
  return {
    searchLinearIssues: (query, limit = 20, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const workspaceId = getSelectedWorkspaceId(get().linearStatus, options)
      const key = scopedLinearCacheKey(scope, linearSearchCacheKey(workspaceId, query, limit))
      return openStoreLinearIssueRead({
        set,
        scope,
        key,
        workspaceId,
        get,
        force: options?.force,
        requests: inflightSearchRequests,
        cached: get().linearSearchCache[key],
        dispatch: () =>
          linearSearchIssues(scope.settings, query, limit, workspaceId).catch(throwReadError),
        publish: (data) =>
          set((state) => ({
            linearSearchCache: evictStaleEntries({
              ...state.linearSearchCache,
              [key]: { data, fetchedAt: Date.now() }
            })
          }))
      })
    },
    listLinearIssues: (args, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const workspaceId = getSelectedWorkspaceId(get().linearStatus, options)
      const filter = args.filter ?? 'assigned'
      const limit = clampLinearIssueListLimit(args.limit)
      const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
      const key = scopedLinearCacheKey(
        scope,
        linearListCacheKey(workspaceId, filter, limit, attributeFilter)
      )
      return openStoreLinearIssueRead({
        set,
        scope,
        key,
        workspaceId,
        get,
        force: options?.force,
        requests: inflightListRequests,
        cached: get().linearListCache[key],
        dispatch: () =>
          linearListIssues(scope.settings, filter, limit, workspaceId, attributeFilter)
            .then((result) =>
              retainFailedWorkspaceIssues(
                result,
                get().linearListCache[key]?.data?.items ?? [],
                workspaceId
              )
            )
            .catch(throwReadError),
        publish: (data) =>
          set((state) => ({
            linearListCache: evictStaleEntries({
              ...state.linearListCache,
              [key]: { data, fetchedAt: data.errors?.length ? 0 : Date.now() }
            })
          }))
      })
    }
  }
}
