import { useEffect, useMemo } from 'react'
import type { PluginHostListEntry } from '../../../preload/api-types'
import { ensurePluginPanelsLoaded, usePluginPanelsStore } from './plugin-panels'
import {
  pluginTaskSourceKey,
  type PluginTaskSourceRef
} from '../../../shared/plugins/plugin-task-source-ref'

export type ActivePluginTaskSource = PluginTaskSourceRef & {
  key: string
  pluginName: string
  title: string
  icon?: string
}

/** Task sources of enabled plugins. Errored plugins keep their tab so the
 *  failure shows where the user looks for it instead of the tab vanishing. */
export function collectActivePluginTaskSources(
  plugins: readonly PluginHostListEntry[]
): ActivePluginTaskSource[] {
  return plugins
    .filter((plugin) => ['running', 'restarting', 'idle', 'errored'].includes(plugin.status))
    .flatMap((plugin) =>
      (plugin.taskSources ?? []).map((source) => ({
        pluginKey: plugin.pluginKey,
        sourceId: source.id,
        key: pluginTaskSourceKey({ pluginKey: plugin.pluginKey, sourceId: source.id }),
        pluginName: plugin.name,
        title: source.title,
        ...(source.icon ? { icon: source.icon } : {})
      }))
    )
}

export function usePluginTaskSources(): {
  sources: ActivePluginTaskSource[]
  ready: boolean
} {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  const fetchStatus = usePluginPanelsStore((state) => state.fetchStatus)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  const sources = useMemo(() => collectActivePluginTaskSources(plugins), [plugins])
  return { sources, ready: fetchStatus === 'ready' || fetchStatus === 'error' }
}
