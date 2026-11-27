import { useEffect, useMemo } from 'react'
import {
  ensurePluginPanelsLoaded,
  installedPluginDisplayNames,
  isLivePlugin,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { pluginSenderKey } from '../../../../../../shared/orchestration/mailbox/plugin-sender-address'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'

export type PluginMessageSender = { name: string; iconUrl?: string }

const NO_PLUGINS: readonly PluginHostListEntry[] = []

/**
 * The enabled plugin a `plugin:<key>` sender address names, as its card shows it. An errored
 * plugin is still installed and consented, so its mail keeps its name and icon.
 */
export function pluginMessageSender(
  plugins: readonly PluginHostListEntry[],
  address: string
): PluginMessageSender | undefined {
  const key = pluginSenderKey(address)
  const plugin = key
    ? plugins.find(
        (candidate) =>
          candidate.pluginKey === key && (isLivePlugin(candidate) || candidate.status === 'errored')
      )
    : undefined
  if (!plugin) {
    return undefined
  }
  const iconUrl = plugin.images?.icon?.url
  return {
    name: installedPluginDisplayNames(plugins).get(plugin.pluginKey) ?? plugin.name,
    ...(iconUrl ? { iconUrl } : {})
  }
}

export function usePluginMessageSender(
  address: string | undefined
): PluginMessageSender | undefined {
  const named = address !== undefined && pluginSenderKey(address) !== null
  useEffect(() => {
    if (named) {
      ensurePluginPanelsLoaded()
    }
  }, [named])
  // Every other sender skips the plugin list, so its refreshes never redraw their cards.
  const plugins = usePluginPanelsStore((state) => (named ? state.plugins : NO_PLUGINS))
  return useMemo(
    () => (named ? pluginMessageSender(plugins, address) : undefined),
    [plugins, address, named]
  )
}
