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
    // Why re-insert: Map keeps insertion order, so this makes the icon the most recently used.
    pathIconComponents.delete(key)
    pathIconComponents.set(key, cached)
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
  // Why LRU, not clear-all: icons still on screen keep their component when old ones go.
  if (pathIconComponents.size >= PATH_ICON_CACHE_LIMIT) {
    const oldest = pathIconComponents.keys().next()
    if (!oldest.done) {
      pathIconComponents.delete(oldest.value)
    }
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

// Why a separator: "Git" must not swallow "GitHub", so only the name plus `:`, `-`, `|` and
// the like counts as already naming the plugin.
const NAME_SEPARATOR = /^\s*[:\-\u2013\u2014|\u00b7/]/

/** The panel's tooltip and accessible name: its title, prefixed with the plugin name unless the
 *  title already is that name or starts with it and a separator. */
export function pluginPanelAccessibleTitle(pluginName: string, title: string): string {
  const name = pluginName.trim().toLocaleLowerCase()
  const lower = title.trim().toLocaleLowerCase()
  if (!name || lower === name) {
    return title
  }
  return lower.startsWith(name) && NAME_SEPARATOR.test(lower.slice(name.length))
    ? title
    : `${pluginName}: ${title}`
}

function spokenName(item: ActivityBarItem): string {
  return item.accessibleTitle ?? item.title
}

function nameCounts(items: readonly ActivityBarItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = spokenName(item).trim().toLocaleLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function collides(item: ActivityBarItem, counts: Map<string, number>): boolean {
  return (counts.get(spokenName(item).trim().toLocaleLowerCase()) ?? 0) > 1
}

/** Gives each plugin panel a tooltip and accessible name no other visible tab shares: a
 *  colliding panel adds its plugin key, then, if that still collides (two panels of one
 *  plugin), its panel path. Built-in tabs keep their names. */
export function withDistinctPluginPanelNames(items: ActivityBarItem[]): ActivityBarItem[] {
  const counts = nameCounts(items)
  if (!items.some((item) => item.pluginKey && collides(item, counts))) {
    return items
  }
  const byPlugin = items.map((item) =>
    item.pluginKey && collides(item, counts)
      ? { ...item, accessibleTitle: `${spokenName(item)} (${item.pluginKey})` }
      : item
  )
  const pluginCounts = nameCounts(byPlugin)
  return byPlugin.map((item, index) => {
    const original = items[index]
    // Why the tab path: it is `publisher/plugin/panel`, unique for every panel.
    return original && item !== original && collides(item, pluginCounts)
      ? {
          ...original,
          accessibleTitle: `${spokenName(original)} (${item.id.replace(/^plugin:/, '')})`
        }
      : item
  })
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
    accessibleTitle: pluginPanelAccessibleTitle(panel.pluginName, panel.title),
    shortcut: '',
    // Plugin panels are app-wide, so a bot's page offers them beside its own tabs.
    onBotPage: true,
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
