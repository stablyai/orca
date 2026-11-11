import {
  Server,
  Bot,
  Code,
  FilePen,
  Gamepad2,
  Keyboard,
  Languages,
  Palette,
  PanelRight,
  Plug,
  Puzzle,
  Shapes,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-types'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginFilterKinds } from './plugin-list-filter'

/**
 * The one catalog category→icon table, mirrored by the marketing site. Filter kinds (themes,
 * languages, icons, editors, commands, machines) are keys too, so a chip reads its kind's row.
 */
export const PLUGIN_CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  themes: Palette,
  'app-themes': Palette,
  'terminal-themes': Palette,
  languages: Code,
  syntax: Code,
  syntaxes: Code,
  'language-packs': Languages,
  localization: Languages,
  icons: Shapes,
  'icon-themes': Shapes,
  editors: FilePen,
  'file-viewers': FilePen,
  commands: Terminal,
  keybindings: Keyboard,
  panels: PanelRight,
  integrations: Plug,
  agents: Bot,
  'vm-recipes': Server,
  machines: Server,
  recipes: Server,
  games: Gamepad2
}

export const PLUGIN_UNKNOWN_CATEGORY_ICON: LucideIcon = Puzzle

// Why: local and dev plugins have no catalog categories, so what they add picks the icon.
const TYPE_ICONS: Partial<Readonly<Record<PluginCatalogType, LucideIcon>>> = {
  'interface-language': Languages,
  panel: PanelRight,
  editor: FilePen
}

export function pluginCategoryIcon(category: string): LucideIcon {
  return Object.hasOwn(PLUGIN_CATEGORY_ICONS, category)
    ? PLUGIN_CATEGORY_ICONS[category]
    : PLUGIN_UNKNOWN_CATEGORY_ICON
}

/** One plugin's icon for a kind it belongs to: its most specific category or type in that kind. */
export function pluginEntryCategoryIcon(
  entry: Pick<PluginListEntry, 'categories' | 'types'>,
  kind: string
): LucideIcon {
  const inKind = (category: string): boolean =>
    pluginFilterKinds({ categories: [category] }).has(kind)
  const specific = entry.categories.find(
    (category) =>
      category !== kind && inKind(category) && Object.hasOwn(PLUGIN_CATEGORY_ICONS, category)
  )
  if (specific) {
    return PLUGIN_CATEGORY_ICONS[specific]
  }
  if (entry.categories.length === 0) {
    const type = entry.types.find(
      (candidate) =>
        TYPE_ICONS[candidate] && pluginFilterKinds({ categories: [], types: [candidate] }).has(kind)
    )
    const icon = type ? TYPE_ICONS[type] : undefined
    if (icon) {
      return icon
    }
  }
  return pluginCategoryIcon(kind)
}
