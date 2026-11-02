import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import {
  linearConnect,
  linearDisconnect,
  linearDisconnectWorkspace,
  linearSelectWorkspace,
  linearTestConnection
} from '@/runtime/runtime-linear-client'
import {
  beginLinearMutation,
  isCurrentLinearMutation,
  isCurrentLinearStatusRead,
  getLinearStatusReadGeneration
} from './linear-slice-request-state'
import { looksLikeAuthError } from './linear-cache'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { detachLinearIssuePublication } from './linear-issue-publication'
import { getLinearReadScope, isCurrentLinearRuntimeContext } from './linear-slice-scope'
import {
  acknowledgeLinearAccount,
  publishLinearAccountStatus,
  removeLinearAccountWorkspaces,
  readLinearAccountStatus
} from './linear-slice-status-actions'

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
  const begin = () => {
    const scope = getLinearReadScope(get().settings)
    const mutation = beginLinearMutation()
    const generation = getLinearStatusReadGeneration()
    return {
      scope,
      current: () =>
        isCurrentLinearMutation(mutation) &&
        isCurrentLinearStatusRead(generation) &&
        isCurrentLinearRuntimeContext(scope.runtimeContextKey, get().settings)
    }
  }
  return {
    testLinearConnection: async (workspaceId) => {
      const { scope, current } = begin()
      try {
        const result = await linearTestConnection(scope.settings, workspaceId)
        if (current()) {
          if (result.ok) {
            acknowledgeLinearAccount(set, get, scope, result.viewer, result.workspace)
          } else if (
            looksLikeAuthError(result.error) ||
            isIntegrationCredentialDecryptionError(result.error)
          ) {
            void readLinearAccountStatus(set, get, scope)
          }
        }
        return result
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : 'Test failed' }
      }
    },
    connectLinear: async (apiKey) => {
      const { scope, current } = begin()
      try {
        const result = await linearConnect(scope.settings, apiKey)
        if (current()) {
          if (result.ok) {
            acknowledgeLinearAccount(set, get, scope, result.viewer, result.workspace)
          } else if (
            looksLikeAuthError(result.error) ||
            isIntegrationCredentialDecryptionError(result.error)
          ) {
            void readLinearAccountStatus(set, get, scope)
          }
        }
        return result
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Connection failed'
        }
      }
    },
    selectLinearWorkspace: async (workspaceId) => {
      const { scope, current } = begin()
      const status = await linearSelectWorkspace(scope.settings, workspaceId)
      if (current()) {
        publishLinearAccountStatus(set, get, scope, status)
      }
    },
    disconnectLinear: async () => {
      const { scope, current } = begin()
      detachLinearIssuePublication(scope, true)
      await linearDisconnect(scope.settings)
      if (current()) {
        publishLinearAccountStatus(set, get, scope, { connected: false, viewer: null })
      }
    },
    disconnectLinearWorkspace: async (workspaceId) => {
      const { scope, current } = begin()
      await linearDisconnectWorkspace(scope.settings, workspaceId)
      if (current()) {
        removeLinearAccountWorkspaces(set, get, scope, [workspaceId])
        if (
          get().linearStatusContextKey !== scope.runtimeContextKey ||
          !get().linearStatus.workspaces
        ) {
          void readLinearAccountStatus(set, get, scope)
        }
      }
    }
  }
}
