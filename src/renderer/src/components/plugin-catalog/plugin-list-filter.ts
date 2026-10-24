import type { PluginListEntry } from './plugin-list-entries'

/** Narrowing the list by kind and by catalog; empty sets mean "any". */
export type PluginListFilter = {
  categories: ReadonlySet<string>
  sourceIds: ReadonlySet<string>
}

export const NO_PLUGIN_LIST_FILTER: PluginListFilter = {
  categories: new Set(),
  sourceIds: new Set()
}

// Why: "official" is trust, shown by the verified mark; it isn't a kind of plugin to filter by.
const NON_KIND_CATEGORIES = new Set(['official'])

/** Catalog categories folded into the kinds people look for; unknown ones stand alone. */
const KIND_BY_CATEGORY: Readonly<Record<string, PluginFilterKind>> = {
  themes: 'themes',
  'app-themes': 'themes',
  'terminal-themes': 'themes',
  icons: 'icons',
  'icon-themes': 'icons',
  languages: 'languages',
  syntax: 'languages',
  syntaxes: 'languages',
  'language-packs': 'languages',
  localization: 'languages',
  keybindings: 'commands',
  commands: 'commands',
  panels: 'commands',
  'vm-recipes': 'machines',
  machines: 'machines',
  recipes: 'machines'
}

export const PLUGIN_FILTER_KINDS = ['themes', 'languages', 'icons', 'commands', 'machines'] as const
export type PluginFilterKind = (typeof PLUGIN_FILTER_KINDS)[number]

export function isPluginFilterKind(value: string): value is PluginFilterKind {
  return PLUGIN_FILTER_KINDS.some((kind) => kind === value)
}

/** The filter kinds one plugin belongs to: known kinds, or the raw category when unmapped. */
export function pluginFilterKinds(entry: Pick<PluginListEntry, 'categories'>): Set<string> {
  const kinds = new Set<string>()
  for (const category of entry.categories) {
    if (!NON_KIND_CATEGORIES.has(category)) {
      kinds.add(KIND_BY_CATEGORY[category] ?? category)
    }
  }
  return kinds
}

/** Kinds present in the list with how many plugins each has; known kinds first, in a fixed order. */
export function pluginFilterCategories(entries: readonly PluginListEntry[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const kind of pluginFilterKinds(entry)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }
  const rank = (kind: string): number => {
    return isPluginFilterKind(kind) ? PLUGIN_FILTER_KINDS.indexOf(kind) : PLUGIN_FILTER_KINDS.length
  }
  return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
}

export function matchesPluginFilter(entry: PluginListEntry, filter: PluginListFilter): boolean {
  if (filter.categories.size > 0) {
    const kinds = pluginFilterKinds(entry)
    if (![...filter.categories].some((kind) => kinds.has(kind))) {
      return false
    }
  }
  if (filter.sourceIds.size > 0) {
    return entry.catalogIds.some((sourceId) => filter.sourceIds.has(sourceId))
  }
  return true
}

export function pluginFilterSize(filter: PluginListFilter): number {
  return filter.categories.size + filter.sourceIds.size
}
