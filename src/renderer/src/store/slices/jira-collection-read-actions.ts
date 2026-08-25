import { jiraListIssues, jiraSearchIssues } from '@/runtime/runtime-jira-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { JiraIssue, JiraSiteSelection } from '../../../../shared/jira-types'
import type { JiraSlice, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  canWriteJiraReadResult,
  createJiraAbortError,
  currentJiraMutationGeneration,
  evictStaleJiraCacheEntries,
  getJiraReadScope,
  getSelectedJiraSiteId,
  inflightListRequests,
  inflightSearchRequests,
  isFreshJiraCacheEntry,
  looksLikeJiraAuthError,
  markJiraConnectionLost,
  scopedJiraCacheKey,
  shouldRefreshJiraStatusAfterRead,
  type InflightJiraReadRequest,
  type JiraReadScope
} from './jira-read-coordination'

type JiraCollectionReadActions = Pick<JiraSlice, 'searchJiraIssues' | 'listJiraIssues'>

function canWriteCollectionResult(
  scope: JiraReadScope,
  mutationGeneration: number,
  get: JiraSliceGet
): boolean {
  return canWriteJiraReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource
  )
}

function handleJiraCollectionReadError(
  error: unknown,
  scope: JiraReadScope,
  siteId: JiraSiteSelection | null | undefined,
  mutationGeneration: number,
  set: JiraSliceSet,
  get: JiraSliceGet,
  options?: { abortable?: boolean }
): JiraIssue[] {
  if (
    isIntegrationCredentialDecryptionError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    if (!shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus, options)) {
      void get().checkJiraConnection()
    }
  } else if (
    looksLikeJiraAuthError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    markJiraConnectionLost(set, scope)
  }
  if (isIntegrationCredentialDecryptionError(error) || looksLikeJiraAuthError(error)) {
    return []
  }
  throw error
}

export function createJiraCollectionReadActions(
  set: JiraSliceSet,
  get: JiraSliceGet
): JiraCollectionReadActions {
  return {
    searchJiraIssues: async (jql, limit = 30, options) => {
      const scope = getJiraReadScope(get().settings, options?.sourceContext)
      const siteId =
        options && 'siteId' in options ? options.siteId : getSelectedJiraSiteId(get().jiraStatus)
      const cacheKey = scopedJiraCacheKey(scope, `${siteId ?? 'default'}::${jql}::${limit}`)
      const cached = get().jiraSearchCache[cacheKey]
      if (isFreshJiraCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightSearchRequests.get(cacheKey)
      const abortable = options?.signal !== undefined
      const requestMutationGeneration = currentJiraMutationGeneration()
      if (
        !abortable &&
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration
      ) {
        return inflight.promise
      }
      let entry: InflightJiraReadRequest<JiraIssue[]>
      const promise = jiraSearchIssues(scope.settings, jql, limit, siteId, options?.signal)
        .then((issues) => {
          if (options?.signal?.aborted) {
            throw createJiraAbortError('search')
          }
          if (
            (abortable || inflightSearchRequests.get(cacheKey) === entry) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            set((state) => ({
              jiraSearchCache: evictStaleJiraCacheEntries({
                ...state.jiraSearchCache,
                [cacheKey]: { data: issues, fetchedAt: Date.now() }
              })
            }))
          }
          return issues
        })
        .catch((error) => {
          if (options?.signal?.aborted) {
            throw error
          }
          console.warn('[jira] searchJiraIssues failed:', error)
          return handleJiraCollectionReadError(
            error,
            scope,
            siteId,
            requestMutationGeneration,
            set,
            get,
            { abortable }
          )
        })
        .finally(() => {
          if (inflightSearchRequests.get(cacheKey) === entry) {
            inflightSearchRequests.delete(cacheKey)
          }
          if (
            !options?.signal?.aborted &&
            shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus, { abortable }) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            void get().checkJiraConnection()
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      if (!abortable) {
        inflightSearchRequests.set(cacheKey, entry)
      }
      return promise
    },

    listJiraIssues: async (filter = 'assigned', limit = 30, options) => {
      const scope = getJiraReadScope(get().settings, options?.sourceContext)
      const siteId = getSelectedJiraSiteId(get().jiraStatus)
      const cacheKey = scopedJiraCacheKey(
        scope,
        `${siteId ?? 'default'}::list::${filter}::${limit}`
      )
      const cached = get().jiraSearchCache[cacheKey]
      if (isFreshJiraCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightListRequests.get(cacheKey)
      const requestMutationGeneration = currentJiraMutationGeneration()
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration
      ) {
        return inflight.promise
      }
      let entry: InflightJiraReadRequest<JiraIssue[]>
      const promise = jiraListIssues(scope.settings, filter, limit, siteId)
        .then((issues) => {
          if (
            inflightListRequests.get(cacheKey) === entry &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            set((state) => ({
              jiraSearchCache: evictStaleJiraCacheEntries({
                ...state.jiraSearchCache,
                [cacheKey]: { data: issues, fetchedAt: Date.now() }
              })
            }))
          }
          return issues
        })
        .catch((error) => {
          console.warn('[jira] listJiraIssues failed:', error)
          return handleJiraCollectionReadError(
            error,
            scope,
            siteId,
            requestMutationGeneration,
            set,
            get
          )
        })
        .finally(() => {
          if (inflightListRequests.get(cacheKey) === entry) {
            inflightListRequests.delete(cacheKey)
          }
          if (
            shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            void get().checkJiraConnection()
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightListRequests.set(cacheKey, entry)
      return promise
    }
  }
}
