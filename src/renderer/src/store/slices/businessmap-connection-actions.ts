import {
  businessmapConnect,
  businessmapDisconnect,
  businessmapReadStatus,
  businessmapSelectSite,
  businessmapStatus,
  businessmapTestConnection
} from '@/runtime/runtime-businessmap-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import type {
  BusinessmapSlice,
  BusinessmapSliceGet,
  BusinessmapSliceSet
} from './businessmap-slice-contract'
import {
  beginBusinessmapMutation,
  businessmapStatusUpdate,
  clearBusinessmapInflightRequests,
  peekBusinessmapMutationGeneration,
  EMPTY_BUSINESSMAP_READ_CACHES,
  getSelectedBusinessmapSiteId,
  isCurrentBusinessmapMutation,
  isCurrentBusinessmapRuntimeContext,
  isCurrentBusinessmapStatusRead,
  nextBusinessmapStatusReadGeneration
} from './businessmap-read-coordination'

type BusinessmapConnectionActions = Pick<
  BusinessmapSlice,
  | 'checkBusinessmapConnection'
  | 'readBusinessmapStatus'
  | 'connectBusinessmap'
  | 'testBusinessmapConnection'
  | 'selectBusinessmapSite'
  | 'disconnectBusinessmap'
>

function businessmapSiteIdentity(site: NonNullable<BusinessmapSlice['businessmapStatus']['sites']>[number]): string {
  return `${site.id}::${site.subdomain}::${site.domain}::${site.displayName ?? ''}::${site.accountName ?? ''}`
}
function hasBusinessmapStatusChanged(
  previous: BusinessmapSlice['businessmapStatus'],
  next: BusinessmapSlice['businessmapStatus']
): boolean {
  const previousSites = previous.sites ?? []
  const nextSites = next.sites ?? []
  const sitesChanged =
    previousSites.length !== nextSites.length ||
    previousSites.some((site, index) => {
      const next = nextSites[index]
      return next === undefined || businessmapSiteIdentity(site) !== businessmapSiteIdentity(next)
    })
  return (
    previous.connected !== next.connected ||
    previous.credentialError !== next.credentialError ||
    previous.viewer?.displayName !== next.viewer?.displayName ||
    previous.viewer?.subdomain !== next.viewer?.subdomain ||
    getSelectedBusinessmapSiteId(previous) !== getSelectedBusinessmapSiteId(next) ||
    sitesChanged
  )
}

export function createBusinessmapConnectionActions(
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet
): BusinessmapConnectionActions {
  return {
    checkBusinessmapConnection: async () => {
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const statusReadGeneration = nextBusinessmapStatusReadGeneration()
      const mutationGeneration = peekBusinessmapMutationGeneration()
      if (get().businessmapStatusContextKey !== contextKey) {
        set({ businessmapStatusChecked: false })
      }
      try {
        const status = await businessmapStatus(get().settings)
        if (
          mutationGeneration !== peekBusinessmapMutationGeneration() ||
          !isCurrentBusinessmapStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        const previous = get().businessmapStatus
        if (hasBusinessmapStatusChanged(previous, status)) {
          set((state) => businessmapStatusUpdate(state, contextKey, status))
        } else if (!get().businessmapStatusChecked) {
          set({ businessmapStatusChecked: true, businessmapStatusContextKey: contextKey })
        } else if (get().businessmapStatusContextKey !== contextKey) {
          set({ businessmapStatusContextKey: contextKey })
        }
      } catch {
        if (
          mutationGeneration !== peekBusinessmapMutationGeneration() ||
          !isCurrentBusinessmapStatusRead(statusReadGeneration) ||
          getProviderRuntimeContextKey(get().settings) !== contextKey
        ) {
          return
        }
        if (get().businessmapStatus.connected) {
          set((state) =>
            businessmapStatusUpdate(state, contextKey, { connected: false, viewer: null })
          )
        } else if (!get().businessmapStatusChecked) {
          set({ businessmapStatusChecked: true, businessmapStatusContextKey: contextKey })
        } else if (get().businessmapStatusContextKey !== contextKey) {
          set({ businessmapStatusContextKey: contextKey })
        }
      }
    },

    readBusinessmapStatus: async (sourceContext) => businessmapReadStatus(sourceContext),

    connectBusinessmap: async (args) => {
      const requestGeneration = beginBusinessmapMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await businessmapConnect(get().settings, args)
        if (
          result.ok &&
          isCurrentBusinessmapMutation(requestGeneration) &&
          isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
        ) {
          set((state) =>
            businessmapStatusUpdate(state, contextKey, { connected: true, viewer: result.viewer })
          )
          void get().checkBusinessmapConnection()
        } else if (result.ok) {
          return {
            ok: false as const,
            error: translate(
              'auto.store.slices.businessmap.856083302c',
              'Businessmap connection was superseded by a newer request.'
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

    testBusinessmapConnection: async (siteId) => {
      const requestGeneration = beginBusinessmapMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      try {
        const result = await businessmapTestConnection(get().settings, siteId)
        if (
          !isCurrentBusinessmapMutation(requestGeneration) ||
          !isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
        ) {
          return result
        }
        const status = await businessmapStatus(get().settings)
        if (
          isCurrentBusinessmapMutation(requestGeneration) &&
          isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
        ) {
          set((state) => businessmapStatusUpdate(state, contextKey, status))
        }
        return result
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : 'Test failed' }
      }
    },

    selectBusinessmapSite: async (siteId) => {
      const requestGeneration = beginBusinessmapMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const status = await businessmapSelectSite(get().settings, siteId)
      if (
        !isCurrentBusinessmapMutation(requestGeneration) ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      clearBusinessmapInflightRequests()
      set((state) =>
        businessmapStatusUpdate(state, contextKey, status, EMPTY_BUSINESSMAP_READ_CACHES)
      )
    },

    disconnectBusinessmap: async (siteId) => {
      const requestGeneration = beginBusinessmapMutation()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      await businessmapDisconnect(get().settings, siteId)
      if (
        !isCurrentBusinessmapMutation(requestGeneration) ||
        !isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
      ) {
        return
      }
      // Why: a failed status refresh must not leave the removed connection visible.
      clearBusinessmapInflightRequests()
      set((state) => ({
        ...EMPTY_BUSINESSMAP_READ_CACHES,
        businessmapStatus: { connected: false, viewer: null },
        businessmapStatusChecked: false,
        businessmapStatusContextKey: state.businessmapStatusContextKey
      }))
      try {
        const status = await businessmapStatus(get().settings)
        if (
          !isCurrentBusinessmapMutation(requestGeneration) ||
          !isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
        ) {
          return
        }
        set((state) =>
          businessmapStatusUpdate(
            state,
            contextKey,
            status.connected ? status : { connected: false, viewer: null },
            EMPTY_BUSINESSMAP_READ_CACHES
          )
        )
      } catch {
        if (
          !isCurrentBusinessmapMutation(requestGeneration) ||
          !isCurrentBusinessmapRuntimeContext(contextKey, get().settings)
        ) {
          return
        }
        set((state) => businessmapStatusUpdate(state, contextKey, { connected: false, viewer: null }, EMPTY_BUSINESSMAP_READ_CACHES))
      }
    }
  }
}
