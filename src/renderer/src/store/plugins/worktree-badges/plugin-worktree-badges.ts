import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginWorktreeBadgeEntry } from '../../../../../shared/plugins/contributions/plugin-worktree-badge-contribution'
import { isWorkspaceScopedPluginContext } from '../../../../../shared/plugins/contributions/plugin-command-contribution'
import {
  fromPlugin,
  installedPluginDisplayNames,
  isLivePlugin,
  usePluginListDerived,
  type ActivePluginCommand
} from '../catalog/plugin-contribution-catalog'

/** A worktree badge of an enabled plugin, its command ids resolved to runnable commands. */
export type ActivePluginWorktreeBadge = Omit<PluginWorktreeBadgeEntry, 'commands'> & {
  key: string
  pluginKey: string
  pluginName: string
  commands: ActivePluginCommand[]
}

export function collectActivePluginWorktreeBadges(
  plugins: readonly PluginHostListEntry[]
): ActivePluginWorktreeBadge[] {
  const names = installedPluginDisplayNames(plugins)
  return plugins.filter(isLivePlugin).flatMap((plugin) =>
    (plugin.worktreeBadges ?? []).flatMap((badge) => {
      const commands = badge.commands.flatMap((commandId) => {
        const command = plugin.commands.find(
          (entry) =>
            entry.id === commandId &&
            isWorkspaceScopedPluginContext(entry.context) &&
            entry.handler.type === 'worker'
        )
        return command ? [fromPlugin(plugin, command, names)] : []
      })
      if (commands.length === 0) {
        return []
      }
      return [
        { ...fromPlugin(plugin, badge, names), key: `${plugin.pluginKey}/${badge.id}`, commands }
      ]
    })
  )
}

/** Worktree badges of enabled plugins, sharing the authoritative plugin-list refresh. */
export function usePluginWorktreeBadges(): ActivePluginWorktreeBadge[] {
  return usePluginListDerived(collectActivePluginWorktreeBadges)
}
