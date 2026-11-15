import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { resolvePluginPanelIcon } from '../../plugins/plugin-panel-icon'

type PluginPanelIcon = ActivityBarItem['icon']

export function resolvePluginPanelActivityIcon(
  iconName: string | undefined,
  iconUrl?: string
): PluginPanelIcon {
  return resolvePluginPanelIcon(iconName, iconUrl)
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    pluginKey: panel.pluginKey,
    icon: resolvePluginPanelActivityIcon(panel.icon, panel.iconUrl),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
