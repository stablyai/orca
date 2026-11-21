import { createElement } from 'react'
import { Puzzle } from 'lucide-react'
import {
  resolvePluginPanelPathIcon,
  type ResolvedPluginPanelPathIcon
} from '../../../../../shared/plugins/contributions/plugin-panel-path-icon'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { resolvePluginIconGlyph } from '../../plugins/plugin-icon-glyphs'

type PluginPanelIcon = ActivityBarItem['icon']

const PATH_ICON_CACHE_LIMIT = 256
// Why cache: the activity bar rebuilds its items on every plugin-list refresh; a stable
// component per icon keeps React from remounting each glyph.
const pathIconComponents = new Map<string, PluginPanelIcon>()

function pathIconComponent(icon: ResolvedPluginPanelPathIcon): PluginPanelIcon {
  const key = `${icon.mode}|${icon.viewBox}|${icon.path}`
  const cached = pathIconComponents.get(key)
  if (cached) {
    return cached
  }
  const stroke = icon.mode === 'stroke'
  // Why attributes, never markup: React sets `d` as a plain attribute, so path data cannot
  // inject elements even from a host older or newer than this client.
  const Icon: PluginPanelIcon = ({ size = 16, className }) =>
    createElement(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: icon.viewBox,
        fill: stroke ? 'none' : 'currentColor',
        stroke: stroke ? 'currentColor' : 'none',
        strokeWidth: stroke ? 2 : undefined,
        strokeLinecap: stroke ? 'round' : undefined,
        strokeLinejoin: stroke ? 'round' : undefined,
        className: className ? `plugin-panel-icon ${className}` : 'plugin-panel-icon',
        style: { forcedColorAdjust: 'none' },
        'aria-hidden': true,
        focusable: false
      },
      createElement('path', { d: icon.path })
    )
  if (pathIconComponents.size >= PATH_ICON_CACHE_LIMIT) {
    pathIconComponents.clear()
  }
  pathIconComponents.set(key, Icon)
  return Icon
}

/** A panel's glyph: its path icon, else its built-in name, else `puzzle`. */
export function resolvePluginPanelIcon(
  iconName: string | undefined,
  iconPath?: unknown
): PluginPanelIcon {
  // Why re-validate: a paired host of another version may send any shape.
  const path = iconPath === undefined ? null : resolvePluginPanelPathIcon(iconPath)
  return path ? pathIconComponent(path) : resolvePluginIconGlyph(iconName, Puzzle)
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {}
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    pluginKey: panel.pluginKey,
    icon: resolvePluginPanelIcon(panel.icon, panel.iconPath),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    accessibleTitle: panel.title.toLowerCase().includes(panel.pluginName.toLowerCase())
      ? panel.title
      : `${panel.pluginName}: ${panel.title}`,
    shortcut: '',
    // Plugin panels are app-wide, so a bot's page offers them beside its own tabs.
    onBotPage: true,
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
