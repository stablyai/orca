import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  voloConnect,
  voloConnectFromSavedCredentials,
  voloDisconnect,
  voloLoginWithGoogle,
  voloStatus,
  voloTestConnection
} from '@/runtime/runtime-volo-client'
import type { VoloConnectionStatus, VoloGoogleLoginResult } from '../../../../shared/volo-types'
import type { VoloSlice, VoloSliceGet, VoloSliceSet } from './volo-slice-contract'

export type { VoloSlice } from './volo-slice-contract'

const DISCONNECTED: VoloConnectionStatus = { connected: false, viewer: null }

function voloStatusUpdate(
  contextKey: string,
  status: VoloConnectionStatus
): Pick<VoloSlice, 'voloStatus' | 'voloStatusChecked' | 'voloStatusContextKey'> {
  return {
    voloStatus: status,
    voloStatusChecked: true,
    voloStatusContextKey: contextKey
  }
}

export function createVoloConnectionActions(set: VoloSliceSet, get: VoloSliceGet): VoloSlice {
  return {
    voloStatus: DISCONNECTED,
    voloStatusChecked: false,
    voloStatusContextKey: null,

    checkVoloConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      if (get().voloStatusContextKey !== contextKey) {
        set({ voloStatusChecked: false })
      }
      try {
        const status = await voloStatus(get().settings)
        if (getProviderRuntimeContextKey(get().settings) !== contextKey) {
          return
        }
        set(voloStatusUpdate(contextKey, status))
      } catch {
        if (getProviderRuntimeContextKey(get().settings) !== contextKey) {
          return
        }
        set(voloStatusUpdate(contextKey, DISCONNECTED))
      }
    },

    readVoloStatus: async (sourceContext) => voloStatus(sourceContext),

    connectVolo: async (args) => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await voloConnect(get().settings, args)
        if (result.ok && getProviderRuntimeContextKey(get().settings) === contextKey) {
          set(voloStatusUpdate(contextKey, { connected: true, viewer: result.viewer }))
          void get().checkVoloConnection()
        }
        return result
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Connection failed'
        }
      }
    },

    connectVoloFromSavedCredentials: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await voloConnectFromSavedCredentials(get().settings)
        if (result.ok && getProviderRuntimeContextKey(get().settings) === contextKey) {
          set(voloStatusUpdate(contextKey, { connected: true, viewer: result.viewer }))
          void get().checkVoloConnection()
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.volo.superseded',
              'Volo connection was superseded by a newer request.'
            )
          }
        }
        return result
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Connection failed'
        }
      }
    },

    connectVoloWithGoogle: async (apiUrl) => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const login = await voloLoginWithGoogle(apiUrl)
        if (!login.ok) {
          return login
        }
        let result: VoloGoogleLoginResult = login
        if (hasRemoteProviderRuntime(get().settings)) {
          const remote = await voloConnect(get().settings, {
            apiToken: login.apiToken,
            apiUrl: login.apiUrl
          })
          result = remote.ok
            ? { ok: true, viewer: remote.viewer, apiToken: login.apiToken, apiUrl: login.apiUrl }
            : remote
        }
        if (result.ok && getProviderRuntimeContextKey(get().settings) === contextKey) {
          set(voloStatusUpdate(contextKey, { connected: true, viewer: result.viewer }))
          void get().checkVoloConnection()
        }
        return result
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Connection failed'
        }
      }
    },

    testVoloConnection: async () => {
      try {
        const result = await voloTestConnection(get().settings)
        const contextKey = getProviderRuntimeContextKey(get().settings)
        const status = await voloStatus(get().settings)
        if (getProviderRuntimeContextKey(get().settings) === contextKey) {
          set(voloStatusUpdate(contextKey, status))
        }
        return result
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Test failed'
        }
      }
    },

    disconnectVolo: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await voloDisconnect(get().settings)
      if (getProviderRuntimeContextKey(get().settings) !== contextKey) {
        return
      }
      set(voloStatusUpdate(contextKey, DISCONNECTED))
    }
  }
}

export const createVoloSlice: StateCreator<AppState, [], [], VoloSlice> = (set, get) =>
  createVoloConnectionActions(set, get)
