import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListTeams } from '@/runtime/runtime-linear-project-client'
import {
  evictStaleEntries,
  getSelectedWorkspaceId,
  isFresh,
  linearTeamsCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead,
  TEAM_CACHE_TTL
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightTeamRequests,
  type InflightLinearTeamRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearTeamActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'getCachedLinearTeams' | 'listLinearTeams'> {
  return {
    getCachedLinearTeams: (workspaceId, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const key = linearTeamsCacheKey(workspaceId ?? getSelectedWorkspaceId(get().linearStatus))
      return get().linearTeamCache[scopedLinearCacheKey(scope, key)]?.data ?? null
    },

    listLinearTeams: async (workspaceId, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
      const cacheKey = scopedLinearCacheKey(scope, linearTeamsCacheKey(resolvedWorkspaceId))
      const cached = get().linearTeamCache[cacheKey]
      if (!options?.force && isFresh(cached, TEAM_CACHE_TTL)) {
        return cached.data ?? []
      }

      const inflight = inflightTeamRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearTeamRequest
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearListTeams(scope.settings, resolvedWorkspaceId)
        .then((teams) => {
          const data = teams as LinearTeam[]
          if (
            inflightTeamRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearTeamCache: evictStaleEntries({
                ...s.linearTeamCache,
                [cacheKey]: { data, fetchedAt: Date.now() }
              })
            }))
          }
          return data
        })
        .catch((error) => {
          console.warn('[linear] listLinearTeams failed:', error)
          if (
            (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            if (!shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus)) {
              void get().checkLinearConnection(true)
            }
            return []
          }
          return get().linearTeamCache[cacheKey]?.data ?? []
        })
        .finally(() => {
          if (inflightTeamRequests.get(cacheKey) === entry) {
            inflightTeamRequests.delete(cacheKey)
          }
          if (
            shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus) &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            void get().checkLinearConnection(true)
          }
        })

      entry = {
        promise,
        force: Boolean(options?.force),
        generation: requestCacheGeneration,
        contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightTeamRequests.set(cacheKey, entry)
      return promise
    }
  }
}
