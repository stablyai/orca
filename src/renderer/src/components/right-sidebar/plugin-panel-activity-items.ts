import { Plug } from 'lucide-react'
import type { ActivePluginPanel } from '@/store/plugin-panels'
import type { ActivityBarItem } from './activity-bar-buttons'
import { resolvePluginIconGlyph } from '../plugins/plugin-icon-glyphs'

type PluginPanelIcon = ActivityBarItem['icon']

export function resolvePluginPanelIcon(iconName: string | undefined): PluginPanelIcon {
  return resolvePluginIconGlyph(iconName, Plug)
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    icon: resolvePluginPanelIcon(panel.icon),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    shortcut: '',
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
