import type { LinearViewer } from '../../../../../shared/linear/workspace-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import {
  linearConnect,
  linearDisconnect,
  linearDisconnectWorkspace,
  linearSelectWorkspace,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  beginLinearMutation,
  invalidateLinearCaches,
  isCurrentLinearMutation
} from './linear-slice-request-state'
import { isCurrentLinearRuntimeContext } from './linear-slice-scope'
import { linearStatusScopeSignature } from './linear-cache'

export function createLinearConnectionActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<
  LinearSlice,
  | 'testLinearConnection'
  | 'connectLinear'
  | 'selectLinearWorkspace'
  | 'disconnectLinear'
  | 'disconnectLinearWorkspace'
> {
  return {
    testLinearConnection: async (workspaceId) => {
      const requestGeneration = beginLinearMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = (await linearTestConnection(get().settings, workspaceId)) as
          | { ok: true; viewer: LinearViewer }
          | { ok: false; error: string }
        if (
          !isCurrentLinearMutation(requestGeneration) ||
          !isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await linearStatus(get().settings)
        if (
          isCurrentLinearMutation(requestGeneration) &&
          isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          const prev = get().linearStatus
          if (linearStatusScopeSignature(prev) !== linearStatusScopeSignature(status)) {
            invalidateLinearCaches()
            set({
              linearStatus: status,
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
          } else if (!get().linearStatusChecked || get().linearStatusContextKey !== contextKey) {
            // Preserve the status reference when the probe did not change scope.
            set({ linearStatusChecked: true, linearStatusContextKey: contextKey })
          }
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Test failed'
        return { ok: false as const, error: message }
      }
    },

    connectLinear: async (apiKey: string) => {
      const requestGeneration = beginLinearMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await linearConnect(get().settings, apiKey)
        if (
          result.ok &&
          isCurrentLinearMutation(requestGeneration) &&
          isCurrentLinearRuntimeContext(contextKey, get().settings)
        ) {
          invalidateLinearCaches()
          set({
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
            linearCustomViewProjectCache: {}
          })
          const status = await linearStatus(get().settings)
          if (
            !isCurrentLinearMutation(requestGeneration) ||
            !isCurrentLinearRuntimeContext(contextKey, get().settings)
          ) {
            return {
              ok: false as const,
              error: translate(
                'auto.store.slices.linear.37d36984d0',
                'Linear connection was superseded by a newer request.'
              )
            }
          }
          set({
            linearStatus: status,
            linearStatusChecked: true,
            linearStatusContextKey: contextKey
          })
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.linear.37d36984d0',
              'Linear connection was superseded by a newer request.'
            )
          }
        }
        return result as { ok: true; viewer: LinearViewer } | { ok: false; error: string }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed'
        return { ok: false as const, error: message }
      }
    },

    selectLinearWorkspace: async (workspaceId) => {
      const requestGeneration = beginLinearMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await linearSelectWorkspace(get().settings, workspaceId)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      invalidateLinearCaches()
      set({
        linearStatus: status,
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
    },

    disconnectLinear: async () => {
      const requestGeneration = beginLinearMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await linearDisconnect(get().settings)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
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
    },

    disconnectLinearWorkspace: async (workspaceId) => {
      const requestGeneration = beginLinearMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await linearDisconnectWorkspace(get().settings, workspaceId)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      const status = await linearStatus(get().settings)
      if (
        !isCurrentLinearMutation(requestGeneration) ||
        !isCurrentLinearRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      invalidateLinearCaches()
      set({
        linearStatus: status,
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
    }
  }
}
