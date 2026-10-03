import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import { listRuntimePlugins, pluginRuntimeOwner } from '@/runtime/runtime-plugin-client'
import type { PluginHostListEntry } from '../../../preload/api-types'
import type { PluginPanelsFetchStatus } from './plugin-panels'

export type RemotePluginCatalog = {
  plugins: PluginHostListEntry[]
  fetchStatus: PluginPanelsFetchStatus
  panelErrors: Record<string, true>
}
const emptyCatalog: RemotePluginCatalog = { plugins: [], fetchStatus: 'loading', panelErrors: {} }
export const useRemotePluginPanelsStore = create<{ catalogs: Record<string, RemotePluginCatalog> }>(
  () => ({ catalogs: {} })
)
const subscriptions = new Map<string, { count: number; dispose: () => void }>()

/** One polling loop per visible host; older hosts need no new subscription RPC. */
export function subscribeRemotePlugins(environmentId: string): () => void {
  const existing = subscriptions.get(environmentId)
  if (existing) {
    existing.count += 1
  } else {
    let disposed = false
    const publish = (catalog: RemotePluginCatalog): void => {
      if (!disposed) {
        useRemotePluginPanelsStore.setState((state) => {
          const installed = new Set<string>(
            catalog.plugins.flatMap((plugin) => plugin.panels.map((panel) => panel.tabKey))
          )
          const panelErrors: Record<string, true> = {}
          for (const key of Object.keys(state.catalogs[environmentId]?.panelErrors ?? {})) {
            if (installed.has(key)) {
              panelErrors[key] = true
            }
          }
          return { catalogs: { ...state.catalogs, [environmentId]: { ...catalog, panelErrors } } }
        })
      }
    }
    const refresh = async (): Promise<void> => {
      try {
        publish({
          plugins: await listRuntimePlugins(environmentId),
          fetchStatus: 'ready',
          panelErrors: {}
        })
      } catch {
        // Offline and unsupported hosts must not leave executable stale contributions.
        publish({ plugins: [], fetchStatus: 'error', panelErrors: {} })
      }
    }
    const stopPolling = installWindowVisibilityTimeoutPoller({
      run: refresh,
      getDelayMs: () => 10_000
    })
    subscriptions.set(environmentId, {
      count: 1,
      dispose: () => {
        disposed = true
        stopPolling()
        useRemotePluginPanelsStore.setState((state) => {
          const catalogs = { ...state.catalogs }
          delete catalogs[environmentId]
          return { catalogs }
        })
      }
    })
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const entry = subscriptions.get(environmentId)
    if (entry && --entry.count === 0) {
      entry.dispose()
      subscriptions.delete(environmentId)
    }
  }
}

export function useRemotePluginCatalog(): RemotePluginCatalog & {
  environmentId: string | null | undefined
} {
  const environmentId = useAppStore(pluginRuntimeOwner)
  const catalog = useRemotePluginPanelsStore((state) =>
    environmentId ? (state.catalogs[environmentId] ?? emptyCatalog) : emptyCatalog
  )
  useEffect(
    () => (environmentId ? subscribeRemotePlugins(environmentId) : undefined),
    [environmentId]
  )
  return { ...catalog, environmentId }
}

export function setRemotePluginPanelHealth(
  environmentId: string,
  tabKey: string,
  health: 'healthy' | 'error'
): void {
  useRemotePluginPanelsStore.setState((state) => {
    const catalog = state.catalogs[environmentId]
    if (!catalog) {
      return state
    }
    const panelErrors = { ...catalog.panelErrors }
    if (health === 'error') {
      panelErrors[tabKey] = true
    } else {
      delete panelErrors[tabKey]
    }
    return { catalogs: { ...state.catalogs, [environmentId]: { ...catalog, panelErrors } } }
  })
}
