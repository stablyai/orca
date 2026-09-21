import { useEffect, useMemo } from 'react'

import { useAppStore } from '@/store'
import { ensurePluginPanelsLoaded, usePluginPanelsStore } from './plugin-panels'
import { deriveContributedPluginTaskSources } from './slices/plugin-task-sources'

/** Forwards the plugin list's task-source contributions into the app store.
 *  The list itself stays owned by `usePluginPanelsStore` — this shares that
 *  fetch rather than opening a second source of truth for installed plugins. */
export function usePluginTaskSourceContributions(): void {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  const setPluginTaskSources = useAppStore((state) => state.setPluginTaskSources)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  const contributed = useMemo(() => deriveContributedPluginTaskSources(plugins), [plugins])
  useEffect(() => {
    setPluginTaskSources(contributed)
    const selected = useAppStore.getState().selectedPluginTaskSource
    // Disabling or removing the plugin would otherwise strand the Tasks page on
    // a list whose source bar entry is gone.
    if (
      selected &&
      !contributed.some(
        (source) => source.pluginKey === selected.pluginKey && source.sourceId === selected.sourceId
      )
    ) {
      useAppStore.getState().selectPluginTaskSource(null)
    }
  }, [contributed, setPluginTaskSources])
}
