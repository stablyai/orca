import { mantisBTListProjects } from '@/runtime/runtime-mantisbt-client'
import type { MantisBTProject } from '../../../../shared/mantisbt-types'
import type { MantisBTSlice, MantisBTSliceGet, MantisBTSliceSet } from './mantisbt-slice-contract'
import {
  canWriteMantisBTReadResult,
  currentMantisBTMutationGeneration,
  evictStaleMantisBTCacheEntries,
  getMantisBTReadScope,
  getSelectedMantisBTSiteId,
  inflightMantisBTProjectRequests,
  isFreshMantisBTCacheEntry,
  looksLikeMantisBTAuthError,
  markMantisBTConnectionLost,
  scopedMantisBTCacheKey,
  type InflightMantisBTReadRequest,
  type MantisBTReadScope
} from './mantisbt-read-coordination'

type MantisBTProjectReadActions = Pick<MantisBTSlice, 'listMantisBTProjects'>

function canWriteProjectResult(
  scope: MantisBTReadScope,
  mutationGeneration: number,
  get: MantisBTSliceGet
): boolean {
  return canWriteMantisBTReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource
  )
}

export function createMantisBTProjectReadActions(
  set: MantisBTSliceSet,
  get: MantisBTSliceGet
): MantisBTProjectReadActions {
  return {
    listMantisBTProjects: async (options) => {
      const scope = getMantisBTReadScope(get().settings, options?.sourceContext)
      const siteId = options?.siteId ?? getSelectedMantisBTSiteId(get().mantisBTStatus)
      const cacheKey = scopedMantisBTCacheKey(scope, `${siteId ?? 'default'}::projects`)
      const cached = get().mantisBTProjectCache[cacheKey]
      if (isFreshMantisBTCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightMantisBTProjectRequests.get(cacheKey)
      const requestMutationGeneration = currentMantisBTMutationGeneration()
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration
      ) {
        return inflight.promise
      }
      let entry: InflightMantisBTReadRequest<MantisBTProject[]>
      const promise = mantisBTListProjects(scope.settings, siteId)
        .then((projects) => {
          if (
            inflightMantisBTProjectRequests.get(cacheKey) === entry &&
            canWriteProjectResult(scope, requestMutationGeneration, get)
          ) {
            set((state) => ({
              mantisBTProjectCache: evictStaleMantisBTCacheEntries({
                ...state.mantisBTProjectCache,
                [cacheKey]: { data: projects, fetchedAt: Date.now() }
              })
            }))
          }
          return projects
        })
        .catch((error) => {
          console.warn('[mantisbt] listMantisBTProjects failed:', error)
          if (
            looksLikeMantisBTAuthError(error) &&
            canWriteProjectResult(scope, requestMutationGeneration, get)
          ) {
            markMantisBTConnectionLost(set, scope)
            return []
          }
          throw error
        })
        .finally(() => {
          if (inflightMantisBTProjectRequests.get(cacheKey) === entry) {
            inflightMantisBTProjectRequests.delete(cacheKey)
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightMantisBTProjectRequests.set(cacheKey, entry)
      return promise
    }
  }
}
