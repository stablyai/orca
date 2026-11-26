import { createElement } from 'react'
import { Puzzle } from 'lucide-react'
import {
  resolvePluginPanelPathIcon,
  type ResolvedPluginPanelPathIcon
} from '../../../../../shared/plugins/contributions/plugin-panel-path-icon'
import { parsePluginImageUrl } from '../../../../../shared/plugins/images/plugin-image-url'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import {
  activityItemAriaLabel,
  activityItemSpokenName,
  activityItemTooltip,
  type ActivityItemStatus
} from '../activity-bar/activity-bar-item-names'
import { resolvePluginIconGlyph } from '../../plugins/plugin-icon-glyphs'
import { PluginContributionIcon } from '../../plugins/PluginContributionIcon'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type PluginPanelIcon = ActivityBarItem['icon']

const ICON_CACHE_LIMIT = 256
// Why cache: the activity bar rebuilds its items on every plugin-list refresh; a stable
// component per icon keeps React from remounting each glyph or image.
const iconComponents = new Map<string, PluginPanelIcon>()

function cachedIconComponent(key: string, create: () => PluginPanelIcon): PluginPanelIcon {
  const cached = iconComponents.get(key)
  if (cached) {
    // Why re-insert: Map keeps insertion order, so this makes the icon the most recently used.
    iconComponents.delete(key)
    iconComponents.set(key, cached)
    return cached
  }
  // Why LRU, not clear-all: icons still on screen keep their component when old ones go.
  if (iconComponents.size >= ICON_CACHE_LIMIT) {
    const oldest = iconComponents.keys().next()
    if (!oldest.done) {
      iconComponents.delete(oldest.value)
    }
  }
  const Icon = create()
  iconComponents.set(key, Icon)
  return Icon
}

function pathIconComponent(icon: ResolvedPluginPanelPathIcon): PluginPanelIcon {
  const stroke = icon.mode === 'stroke'
  // Why attributes, never markup: React sets `d` as a plain attribute, so path data cannot
  // inject elements even from a host older or newer than this client.
  return cachedIconComponent(
    `path|${icon.mode}|${icon.viewBox}|${icon.path}`,
    () =>
      ({ size = 16, className }) =>
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
  )
}

/** The panel's image in the glyph's box, in its own colors; `puzzle` if it does not load. */
function imageIconComponent(url: string): PluginPanelIcon {
  return cachedIconComponent(
    `image|${url}`,
    () =>
      ({ size = 16, className }) =>
        createElement(PluginContributionIcon, {
          url,
          size,
          className: className ?? '',
          fallback: createElement(Puzzle, { size, className, 'aria-hidden': true })
        })
  )
}

/** A panel's icon: its image, else its path icon, else its built-in name, else `puzzle`. */
export function resolvePluginPanelIcon(
  iconName: string | undefined,
  iconPath?: unknown,
  iconImage?: unknown
): PluginPanelIcon {
  // Why re-validate: a paired host of another version may send any shape, and only an image
  // main serves may load, so a web URL cannot hotlink.
  if (typeof iconImage === 'string' && parsePluginImageUrl(iconImage)) {
    return imageIconComponent(iconImage)
  }
  const path = iconPath === undefined ? null : resolvePluginPanelPathIcon(iconPath)
  return path ? pathIconComponent(path) : resolvePluginIconGlyph(iconName, Puzzle)
}

// Why a separator: "Git" must not swallow "GitHub", so only the name plus `:`, `-`, `|` and
// the like counts as already naming the plugin.
const NAME_SEPARATOR = /^\s*[:\-–—|·/]/

const NO_NAMES: ReadonlySet<string> = new Set()

/** The name a screen reader compares: whitespace collapsed, case folded. Not locale-aware, so the
 *  same two labels compare equal on every machine. */
function nameKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The normalized final strings of each built-in tab: its accessible name (count and status word
 *  included) and its tooltip. No plugin tab may read as exactly one of them. */
export function builtInTabNames(
  items: readonly ActivityBarItem[],
  t: Translate = translate
): ReadonlySet<string> {
  return new Set(items.flatMap((item) => finalNameKeys(item, (built) => built.statusIndicator, t)))
}

/** The panel's tooltip and accessible name: its title, prefixed with the plugin name unless the
 *  title already is that name or starts with it and a separator. A name that would read as exactly
 *  a built-in tab's tooltip is prefixed too, so a plugin tab never reads as a built-in one. */
export function pluginPanelAccessibleTitle(
  pluginName: string,
  title: string,
  builtInNames: ReadonlySet<string> = NO_NAMES
): string {
  const name = nameKey(pluginName)
  if (!name) {
    return title
  }
  const key = nameKey(title)
  const alreadyNamed =
    key === name || (key.startsWith(name) && NAME_SEPARATOR.test(key.slice(name.length)))
  const prefixed = `${pluginName.trim()}: ${title}`
  const named = alreadyNamed ? title : prefixed
  return builtInNames.has(nameKey(named)) ? prefixed : named
}

/** The status a tab is announced with. */
export type PanelNameStatus = (item: ActivityBarItem) => ActivityItemStatus | null | undefined

/** Normalized strings a tab is announced and shown by: its accessible name, which carries the count
 *  ("Home, 1 needs you") and the status word, and its tooltip. Both are compared, since a tooltip
 *  can match another tab's name while the accessible names differ by the count or status word. */
function finalNameKeys(item: ActivityBarItem, statusOf: PanelNameStatus, t: Translate): string[] {
  return [activityItemAriaLabel(item, statusOf(item), t), activityItemTooltip(item)].map(nameKey)
}

function nameCounts(
  items: readonly ActivityBarItem[],
  statusOf: PanelNameStatus,
  t: Translate
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const key of new Set(finalNameKeys(item, statusOf, t))) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function collides(
  item: ActivityBarItem,
  counts: ReadonlyMap<string, number>,
  statusOf: PanelNameStatus,
  t: Translate
): boolean {
  return finalNameKeys(item, statusOf, t).some((key) => (counts.get(key) ?? 0) > 1)
}

function withAccessibleTitle(item: ActivityBarItem, accessibleTitle: string): ActivityBarItem {
  return { ...item, accessibleTitle }
}

/** Gives each plugin panel an accessible name and tooltip no other visible tab shares, judged on
 *  the final text each tab shows (status word and shortcut hint included). A colliding panel adds
 *  its plugin key, then, if that still collides (two panels of one plugin, or a name another tab
 *  already has), its panel path, then a number. Built-in tabs keep their names. */
export function withDistinctPluginPanelNames(
  items: ActivityBarItem[],
  statusOf: PanelNameStatus = (item) => item.statusIndicator,
  t: Translate = translate
): ActivityBarItem[] {
  const counts = nameCounts(items, statusOf, t)
  if (!items.some((item) => item.pluginKey && collides(item, counts, statusOf, t))) {
    return items
  }
  const byPlugin = items.map((item) =>
    item.pluginKey && collides(item, counts, statusOf, t)
      ? withAccessibleTitle(item, `${activityItemSpokenName(item)} (${item.pluginKey})`)
      : item
  )
  const pluginCounts = nameCounts(byPlugin, statusOf, t)
  return byPlugin.map((item, index) => {
    const original = items[index]
    // Why every plugin tab, not only renamed ones: a tab whose name was fine can still match a
    // key a renamed tab just took. Built-in tabs are never renamed.
    if (!original || !item.pluginKey || !collides(item, pluginCounts, statusOf, t)) {
      return item
    }
    const panelName = `${activityItemSpokenName(original)} (${item.id.replace(/^plugin:/, '')})`
    let renamed = withAccessibleTitle(original, panelName)
    // Another tab can already use the generated panel name as its own title.
    for (
      let suffix = 2;
      finalNameKeys(renamed, statusOf, t).some((key) => pluginCounts.has(key));
      suffix++
    ) {
      renamed = withAccessibleTitle(original, `${panelName} (${suffix})`)
    }
    for (const key of finalNameKeys(renamed, statusOf, t)) {
      pluginCounts.set(key, 1)
    }
    return renamed
  })
}

export function getPluginPanelActivityItems(
  panels: ActivePluginPanel[],
  panelErrors: Readonly<Record<string, true>> = {},
  builtInNames: ReadonlySet<string> = NO_NAMES
): ActivityBarItem[] {
  return panels.map((panel) => ({
    id: panel.tabKey,
    pluginKey: panel.pluginKey,
    icon: resolvePluginPanelIcon(panel.icon, panel.iconPath, panel.iconImage),
    // Manifest titles are plugin-owned and render without app-catalog translation.
    title: panel.title,
    // Why the id when the name is blank: a whitespace-only display name would drop the plugin's
    // identity from the tab's accessible name.
    accessibleTitle: pluginPanelAccessibleTitle(
      panel.pluginName.trim() || panel.pluginKey,
      panel.title,
      builtInNames
    ),
    shortcut: '',
    // Plugin panels are app-wide, so a bot's page offers them beside its own tabs.
    onBotPage: true,
    ...(panelErrors[panel.tabKey] ? { statusIndicator: 'failure' as const } : {})
  }))
}
