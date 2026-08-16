import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PlaneCollectionResult,
  PlaneConnectArgs,
  PlaneConnectionStatus,
  PlaneIssueQuery,
  PlaneMember,
  PlaneOAuthConnectArgs,
  PlaneProject,
  PlaneWorkItem
} from '../../../../shared/plane/types'
import type { CacheEntry } from './github'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  planeConnect,
  planeConnectOAuth,
  planeDisconnect,
  planeSelectInstance,
  planeStatus,
  planeTestConnection
} from '@/runtime/runtime-plane-client'
import {
  beginPlaneMutation,
  type PlaneProjectResources,
  type PlaneReadOptions
} from './plane-cache'
import { createPlaneReadActions } from './plane-read-actions'

export type PlaneSlice = {
  planeStatus: PlaneConnectionStatus
  planeStatusChecked: boolean
  planeStatusContextKey: string | null
  planeIssueListCache: Record<string, CacheEntry<PlaneCollectionResult<PlaneWorkItem>>>
  planeProjectCache: Record<string, CacheEntry<PlaneProject[]>>
  planeMemberCache: Record<string, CacheEntry<PlaneMember[]>>
  planeProjectResourceCache: Record<string, CacheEntry<PlaneProjectResources>>
  checkPlaneConnection: (force?: boolean) => Promise<void>
  connectPlane: (args: PlaneConnectArgs) => Promise<{ ok: true } | { ok: false; error: string }>
  connectPlaneOAuth: (
    args: PlaneOAuthConnectArgs
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  disconnectPlane: (instanceId?: string) => Promise<void>
  selectPlaneInstance: (instanceId: string) => Promise<void>
  testPlaneConnection: (instanceId?: string) => ReturnType<typeof planeTestConnection>
  listPlaneIssues: (
    query: PlaneIssueQuery,
    limit: number,
    instanceId?: string,
    options?: PlaneReadOptions
  ) => Promise<PlaneCollectionResult<PlaneWorkItem>>
  listPlaneProjects: (instanceId?: string, options?: PlaneReadOptions) => Promise<PlaneProject[]>
  listPlaneMembers: (instanceId?: string, options?: PlaneReadOptions) => Promise<PlaneMember[]>
  listPlaneProjectResources: (
    projectId: string,
    instanceId?: string,
    options?: PlaneReadOptions
  ) => Promise<PlaneProjectResources>
}

const EMPTY_STATUS: PlaneConnectionStatus = {
  connected: false,
  activeInstanceId: null,
  selectedInstanceId: null,
  instances: [],
  viewer: null
}

const EMPTY_PLANE_READ_CACHES = {
  planeIssueListCache: {},
  planeProjectCache: {},
  planeMemberCache: {},
  planeProjectResourceCache: {}
} satisfies Partial<PlaneSlice>

export const createPlaneSlice: StateCreator<AppState, [], [], PlaneSlice> = (set, get) => ({
  planeStatus: EMPTY_STATUS,
  planeStatusChecked: false,
  planeStatusContextKey: null,
  planeIssueListCache: {},
  planeProjectCache: {},
  planeMemberCache: {},
  planeProjectResourceCache: {},

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
    beginPlaneMutation()
    set(EMPTY_PLANE_READ_CACHES)
    await get().checkPlaneConnection(true)
    return { ok: true }
  },

  connectPlaneOAuth: async (args) => {
    const result = await planeConnectOAuth(get().settings, args)
    if (!result.ok) {
      return result
    }
    beginPlaneMutation()
    set(EMPTY_PLANE_READ_CACHES)
    await get().checkPlaneConnection(true)
    return { ok: true }
  },

  disconnectPlane: async (instanceId) => {
    await planeDisconnect(get().settings, instanceId)
    beginPlaneMutation()
    set(EMPTY_PLANE_READ_CACHES)
    await get().checkPlaneConnection(true)
  },

  selectPlaneInstance: async (instanceId) => {
    const status = await planeSelectInstance(get().settings, instanceId)
    beginPlaneMutation()
    set({ ...EMPTY_PLANE_READ_CACHES, planeStatus: status, planeStatusChecked: true })
  },

  testPlaneConnection: (instanceId) => planeTestConnection(get().settings, instanceId),
  ...createPlaneReadActions(set, get)
})
