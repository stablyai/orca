import { jiraGetIssue, jiraLookupIssueSummary } from '@/runtime/runtime-jira-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { JiraSlice, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  canWriteJiraReadResult,
  createJiraAbortError,
  currentJiraMutationGeneration,
  evictStaleJiraCacheEntries,
  getJiraReadScope,
  inflightIssueRequests,
  inflightIssueSummaryRequests,
  isFreshJiraCacheEntry,
  looksLikeJiraAuthError,
  markJiraConnectionLost,
  scopedJiraCacheKey,
  shouldRefreshJiraStatusAfterRead,
  subscribeToJiraSummaryRequest,
  type InflightJiraReadRequest,
  type SharedJiraSummaryRequest
} from './jira-read-coordination'

type JiraIssueReadActions = Pick<JiraSlice, 'lookupJiraIssueSummary' | 'fetchJiraIssue'>

export function createJiraIssueReadActions(
  set: JiraSliceSet,
  get: JiraSliceGet
): JiraIssueReadActions {
  return {
    lookupJiraIssueSummary: async (sourceContext, key, siteId, options) => {
      const scope = getJiraReadScope(get().settings, sourceContext)
      const cacheKey = scopedJiraCacheKey(scope, `${siteId}::${key.toUpperCase()}`)
      const cached = get().jiraIssueSummaryCache[cacheKey]
      if (!options?.force && isFreshJiraCacheEntry(cached)) {
        return cached.data
      }
      if (options?.force && cached) {
        set((state) => {
          const jiraIssueSummaryCache = { ...state.jiraIssueSummaryCache }
          delete jiraIssueSummaryCache[cacheKey]
          return { jiraIssueSummaryCache }
        })
      }
      const inflight = inflightIssueSummaryRequests.get(cacheKey)
      if (!options?.force && inflight?.contextKey === scope.contextKey) {
        return subscribeToJiraSummaryRequest(inflight, options?.signal)
      }
      if (options?.signal?.aborted) {
        throw createJiraAbortError('issue summary lookup')
      }
      let entry: SharedJiraSummaryRequest
      const controller = new AbortController()
      const promise = jiraLookupIssueSummary(scope.settings, key, siteId, controller.signal)
        .then((issue) => {
          if (
            issue &&
            issue.key.toUpperCase() === key.toUpperCase() &&
            issue.siteId === siteId &&
            inflightIssueSummaryRequests.get(cacheKey) === entry
          ) {
            set((state) => ({
              jiraIssueSummaryCache: evictStaleJiraCacheEntries({
                ...state.jiraIssueSummaryCache,
                [cacheKey]: { data: issue, fetchedAt: Date.now() }
              })
            }))
          }
          return issue
        })
        .finally(() => {
          if (inflightIssueSummaryRequests.get(cacheKey) === entry) {
            inflightIssueSummaryRequests.delete(cacheKey)
          }
        })
      entry = {
        promise,
        controller,
        subscribers: 0,
        contextKey: scope.contextKey,
        mutationGeneration: currentJiraMutationGeneration()
      }
      inflightIssueSummaryRequests.set(cacheKey, entry)
      return subscribeToJiraSummaryRequest(entry, options?.signal)
    },

    fetchJiraIssue: async (key, siteId, options) => {
      const scope = getJiraReadScope(get().settings, options?.sourceContext)
      const issueCacheKey = scopedJiraCacheKey(scope, `${siteId ?? 'selected'}::${key}`)
      const cached = get().jiraIssueCache[issueCacheKey] ?? get().jiraIssueCache[key]
      if (isFreshJiraCacheEntry(cached)) {
        return cached.data
      }
      const inflight = inflightIssueRequests.get(issueCacheKey)
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === currentJiraMutationGeneration()
      ) {
        return inflight.promise
      }
      let entry: InflightJiraReadRequest<JiraIssue | null>
      const requestMutationGeneration = currentJiraMutationGeneration()
      const promise = jiraGetIssue(scope.settings, key, siteId)
        .then((issue) => {
          if (
            inflightIssueRequests.get(issueCacheKey) === entry &&
            canWriteJiraReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((state) => ({
              jiraIssueCache: evictStaleJiraCacheEntries({
                ...state.jiraIssueCache,
                [issueCacheKey]: { data: issue, fetchedAt: Date.now() }
              })
            }))
          }
          return issue
        })
        .catch((error) => {
          console.warn('[jira] fetchJiraIssue failed:', error)
          if (
            isIntegrationCredentialDecryptionError(error) &&
            canWriteJiraReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            if (!shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus)) {
              void get().checkJiraConnection()
            }
          } else if (
            looksLikeJiraAuthError(error) &&
            canWriteJiraReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            markJiraConnectionLost(set, scope)
          }
          return null
        })
        .finally(() => {
          if (inflightIssueRequests.get(issueCacheKey) === entry) {
            inflightIssueRequests.delete(issueCacheKey)
          }
          if (
            shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus) &&
            canWriteJiraReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            void get().checkJiraConnection()
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightIssueRequests.set(issueCacheKey, entry)
      return promise
    }
  }
}
