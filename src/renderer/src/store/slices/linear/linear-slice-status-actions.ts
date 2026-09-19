import type { LinearConnectionStatus } from '../../../../../shared/linear/workspace-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { linearStatus } from '@/runtime/runtime-linear-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  getInflightStatusRequest,
  getLinearMutationGeneration,
  invalidateLinearCaches,
  isCurrentLinearStatusRead,
  nextLinearStatusReadGeneration,
  setInflightStatusRequest
} from './linear-slice-request-state'
import { linearStatusScopeSignature } from './linear-cache'
import { isCurrentLinearRuntimeContext } from './linear-slice-scope'

export function createLinearStatusActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'checkLinearConnection'> {
  return {
    checkLinearConnection: async (force = false) => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const inflightStatusRequest = getInflightStatusRequest()
      if (inflightStatusRequest && !force && inflightStatusRequest.contextKey === contextKey) {
        return inflightStatusRequest.promise
      }
      if (get().linearStatusContextKey !== contextKey && get().linearStatusChecked) {
        set({ linearStatusChecked: false })
      }

      const mutationGeneration = getLinearMutationGeneration()
      const statusReadGeneration = nextLinearStatusReadGeneration()
      const request = linearStatus(get().settings)
        .then((status) => {
          if (
            mutationGeneration !== getLinearMutationGeneration() ||
            !isCurrentLinearStatusRead(statusReadGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return
          }
          const typedStatus = status as LinearConnectionStatus
          const prev = get().linearStatus
          const prevScopeSignature = linearStatusScopeSignature(prev)
          const nextScopeSignature = linearStatusScopeSignature(typedStatus)
          if (prevScopeSignature !== nextScopeSignature) {
            invalidateLinearCaches()
            set({
              linearStatus: typedStatus,
              linearIssueCache: {},
              linearSearchCache: {},
              linearListCache: {},
              linearTeamCache: {},
              linearProjectCache: {},
              linearProjectDetailCache: {},
              linearProjectIssueCache: {},
              linearCustomViewCache: {},
              linearCustomViewDetailCache: {},
              linearCustomViewIssueCache: {},
              linearCustomViewProjectCache: {},
              linearStatusChecked: true,
              linearStatusContextKey: contextKey
            })
          } else if (!get().linearStatusChecked) {
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          } else if (get().linearStatusContextKey !== contextKey) {
            set({ linearStatusContextKey: contextKey })
          }
        })
        .catch(() => {
          if (
            mutationGeneration !== getLinearMutationGeneration() ||
            !isCurrentLinearStatusRead(statusReadGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return
          }
          if (get().linearStatus.connected) {
            invalidateLinearCaches()
            set({
              linearStatus: { connected: false, viewer: null },
              linearIssueCache: {},
              linearSearchCache: {},
              linearListCache: {},
              linearTeamCache: {},
              linearProjectCache: {},
              linearProjectDetailCache: {},
              linearProjectIssueCache: {},
              linearCustomViewCache: {},
              linearCustomViewDetailCache: {},
              linearCustomViewIssueCache: {},
              linearCustomViewProjectCache: {},
              linearStatusChecked: true,
              linearStatusContextKey: contextKey
            })
          } else if (!get().linearStatusChecked) {
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          } else if (get().linearStatusContextKey !== contextKey) {
            set({ linearStatusContextKey: contextKey })
          }
        })
        .finally(() => {
          if (
            isCurrentLinearStatusRead(statusReadGeneration) &&
            getInflightStatusRequest()?.promise === request
          ) {
            setInflightStatusRequest(null)
          }
        })
      setInflightStatusRequest({ contextKey, promise: request })

      return request
    }
  }
}
