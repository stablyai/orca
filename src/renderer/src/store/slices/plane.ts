import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneOAuthConnectArgs
} from '../../../../shared/plane/types'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  planeConnect,
  planeConnectOAuth,
  planeDisconnect,
  planeStatus,
  planeTestConnection
} from '@/runtime/runtime-plane-client'

export type PlaneSlice = {
  planeStatus: PlaneConnectionStatus
  planeStatusChecked: boolean
  planeStatusContextKey: string | null
  checkPlaneConnection: (force?: boolean) => Promise<void>
  connectPlane: (args: PlaneConnectArgs) => Promise<{ ok: true } | { ok: false; error: string }>
  connectPlaneOAuth: (
    args: PlaneOAuthConnectArgs
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  disconnectPlane: (instanceId?: string) => Promise<void>
  testPlaneConnection: (instanceId?: string) => ReturnType<typeof planeTestConnection>
}

const EMPTY_STATUS: PlaneConnectionStatus = {
  connected: false,
  activeInstanceId: null,
  selectedInstanceId: null,
  instances: [],
  viewer: null
}

export const createPlaneSlice: StateCreator<AppState, [], [], PlaneSlice> = (set, get) => ({
  planeStatus: EMPTY_STATUS,
  planeStatusChecked: false,
  planeStatusContextKey: null,

  checkPlaneConnection: async (force = false) => {
    const settings = get().settings
    const contextKey = getProviderRuntimeContextKey(settings)
    if (!force && get().planeStatusChecked && get().planeStatusContextKey === contextKey) {
      return
    }
    const status = await planeStatus(settings)
    set({ planeStatus: status, planeStatusChecked: true, planeStatusContextKey: contextKey })
  },

  connectPlane: async (args) => {
    const result = await planeConnect(get().settings, args)
    if (!result.ok) {
      return result
    }
    await get().checkPlaneConnection(true)
    return { ok: true }
  },

  connectPlaneOAuth: async (args) => {
    const result = await planeConnectOAuth(get().settings, args)
    if (!result.ok) {
      return result
    }
    await get().checkPlaneConnection(true)
    return { ok: true }
  },

  disconnectPlane: async (instanceId) => {
    await planeDisconnect(get().settings, instanceId)
    await get().checkPlaneConnection(true)
  },

  testPlaneConnection: (instanceId) => planeTestConnection(get().settings, instanceId)
})
