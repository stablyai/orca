import type { PluginHostListEntry, PluginHostNewFile } from '../../../preload/api-types'
import { isLivePlugin, keyedPluginContribution, usePluginListDerived } from './plugin-panels'

/** A new-file type from an enabled plugin. `key` is unique across plugins; `iconUrl` is its own
 *  icon, else the plugin's. */
export type ActivePluginNewFile = PluginHostNewFile & {
  key: string
  pluginKey: string
  pluginName: string
  iconUrl?: string
}

export function collectActivePluginNewFiles(
  plugins: readonly PluginHostListEntry[]
): ActivePluginNewFile[] {
  return plugins
    .filter(isLivePlugin)
    .flatMap((plugin) =>
      (plugin.newFiles ?? []).map((newFile) => keyedPluginContribution(plugin, newFile))
    )
}

// Why gated: a client without the template reader (a paired web client) cannot create them.
const collectCreatableNewFiles = (
  plugins: readonly PluginHostListEntry[]
): ActivePluginNewFile[] =>
  window.api?.plugins?.readNewFileTemplate ? collectActivePluginNewFiles(plugins) : []

/** New-file types of enabled plugins, sharing the plugin-list refresh. */
export function usePluginNewFiles(): ActivePluginNewFile[] {
  return usePluginListDerived(collectCreatableNewFiles)
}
