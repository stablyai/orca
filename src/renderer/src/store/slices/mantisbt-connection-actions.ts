import {
  mantisBTConnect,
  mantisBTDisconnect,
  mantisBTSelectSite,
  mantisBTStatus,
  mantisBTTestConnection
} from '@/runtime/runtime-mantisbt-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import type { MantisBTSlice, MantisBTSliceGet, MantisBTSliceSet } from './mantisbt-slice-contract'
import type { MantisBTConnectionStatus } from '../../../../shared/mantisbt-types'
import {
  beginMantisBTMutation,
  currentMantisBTMutationGeneration,
  getSelectedMantisBTSiteId,
  isCurrentMantisBTMutation,
  isCurrentMantisBTRuntimeContext,
  isCurrentMantisBTStatusRead,
  mantisBTStatusUpdate,
  nextMantisBTStatusReadGeneration
} from './mantisbt-read-coordination'

const DISCONNECTED_STATUS: MantisBTConnectionStatus = {
  connected: false,
  viewer: null,
  sites: [],
  activeSiteId: null,
  selectedSiteId: null
}

type MantisBTConnectionActions = Pick<
  MantisBTSlice,
  | 'checkMantisBTConnection'
  | 'connectMantisBT'
  | 'testMantisBTConnection'
  | 'selectMantisBTSite'
  | 'disconnectMantisBT'
>

function hasMantisBTStatusChanged(
  previous: MantisBTSlice['mantisBTStatus'],
  next: MantisBTSlice['mantisBTStatus']
): boolean {
  return (
    previous.connected !== next.connected ||
    previous.credentialError !== next.credentialError ||
    previous.viewer?.email !== next.viewer?.email ||
    getSelectedMantisBTSiteId(previous) !== getSelectedMantisBTSiteId(next) ||
    (previous.sites?.length ?? 0) !== (next.sites?.length ?? 0)
  )
}

export function createMantisBTConnectionActions(
  set: MantisBTSliceSet,
  get: MantisBTSliceGet
): MantisBTConnectionActions {
  return {
    checkMantisBTConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const statusReadGeneration = nextMantisBTStatusReadGeneration()
      const mutationGeneration = currentMantisBTMutationGeneration()
      if (get().mantisBTStatusContextKey !== contextKey) {
        set({ mantisBTStatusChecked: false })
      }
      try {
        const status = await mantisBTStatus(get().settings)
        if (
          mutationGeneration !== currentMantisBTMutationGeneration() ||
          !isCurrentMantisBTStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        const previous = get().mantisBTStatus
        if (hasMantisBTStatusChanged(previous, status)) {
          set((state) => mantisBTStatusUpdate(state, contextKey, status))
        } else if (!get().mantisBTStatusChecked) {
          set({ mantisBTStatusChecked: true, mantisBTStatusContextKey: contextKey })
        } else if (get().mantisBTStatusContextKey !== contextKey) {
          set({ mantisBTStatusContextKey: contextKey })
        }
      } catch {
        if (
          mutationGeneration !== currentMantisBTMutationGeneration() ||
          !isCurrentMantisBTStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        if (get().mantisBTStatus.connected) {
          set((state) => mantisBTStatusUpdate(state, contextKey, DISCONNECTED_STATUS))
        } else if (!get().mantisBTStatusChecked) {
          set({ mantisBTStatusChecked: true, mantisBTStatusContextKey: contextKey })
        } else if (get().mantisBTStatusContextKey !== contextKey) {
          set({ mantisBTStatusContextKey: contextKey })
        }
      }
    },

    connectMantisBT: async (args) => {
      const requestGeneration = beginMantisBTMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await mantisBTConnect(get().settings, args)
        if (
          result.ok &&
          isCurrentMantisBTMutation(requestGeneration) &&
          isCurrentMantisBTRuntimeContext(contextKey, get().settings)
        ) {
          set((state) =>
            mantisBTStatusUpdate(state, contextKey, {
              ...get().mantisBTStatus,
              connected: true,
              viewer: result.viewer
            })
          )
          void get().checkMantisBTConnection()
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.mantisBT.connectionSuperseded',
              'MantisBT connection was superseded by a newer request.'
            )
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

    testMantisBTConnection: async (siteId) => {
      const requestGeneration = beginMantisBTMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await mantisBTTestConnection(get().settings, siteId)
        if (
          !isCurrentMantisBTMutation(requestGeneration) ||
          !isCurrentMantisBTRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await mantisBTStatus(get().settings)
        if (
          isCurrentMantisBTMutation(requestGeneration) &&
          isCurrentMantisBTRuntimeContext(contextKey, get().settings)
        ) {
          set((state) => mantisBTStatusUpdate(state, contextKey, status))
        }
        return result
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : 'Test failed' }
      }
    },

    selectMantisBTSite: async (siteId) => {
      const requestGeneration = beginMantisBTMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await mantisBTSelectSite(get().settings, siteId)
      if (
        !isCurrentMantisBTMutation(requestGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      set((state) => mantisBTStatusUpdate(state, contextKey, status))
    },

    disconnectMantisBT: async (siteId) => {
      const requestGeneration = beginMantisBTMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await mantisBTDisconnect(get().settings, siteId)
      if (
        !isCurrentMantisBTMutation(requestGeneration) ||
        !isCurrentMantisBTRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      const status = await mantisBTStatus(get().settings)
      if (
        !isCurrentMantisBTMutation(requestGeneration) ||
        !isCurrentMantisBTRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      set((state) =>
        mantisBTStatusUpdate(state, contextKey, status.connected ? status : DISCONNECTED_STATUS)
      )
    }
  }
}
