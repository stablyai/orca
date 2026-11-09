import type { PluginListEntry } from '../list/plugin-list-entries'
import { LOCAL_PLUGIN_PUBLISHER } from '../../../../../shared/plugins/installation/plugin-publisher-derivation'

export type PluginAuthor = {
  publisher: string
  catalog: string | null
  provenance: 'catalog' | 'git' | 'manifest' | 'unknown'
}

/** Publisher labels describe their source, never a verified account identity. */
export function pluginAuthor(entry: PluginListEntry): PluginAuthor | null {
  const publisher = entry.publisher
  if (!publisher || publisher === LOCAL_PLUGIN_PUBLISHER) {
    return null
  }
  const catalog = entry.installed
    ? pluginAuthorCatalogId(entry)
      ? (entry.listing?.marketplaceName ?? null)
      : entry.verifiedSource.kind === 'catalog'
        ? (entry.verifiedSource.catalog ?? entry.verifiedSource.owner)
        : null
    : (entry.listing?.marketplaceName ?? null)
  const installed = entry.installed
  const sourceKind = installed?.source?.kind
  const provenance: PluginAuthor['provenance'] =
    installed?.isDev || sourceKind === 'local-path'
      ? 'manifest'
      : sourceKind === 'git'
        ? 'git'
        : catalog || sourceKind === 'marketplace' || (!installed && entry.listing)
          ? 'catalog'
          : 'unknown'
  return { publisher, catalog, provenance }
}

/** The catalog scope is known only for listings joined to the installed source. */
export function pluginAuthorCatalogId(entry: PluginListEntry): string | null {
  if (entry.installed) {
    const source = entry.installed.source
    if (
      entry.installed.isDev ||
      source?.kind !== 'marketplace' ||
      !source.marketplace ||
      !entry.updatable
    ) {
      return null
    }
  }
  return entry.listing?.marketplaceSourceId ?? null
}

/** Displayed matches with the same declared publisher in the same catalog, each once. */
export function pluginsBySamePublisher(
  entry: PluginListEntry,
  entries: { installed: readonly PluginListEntry[]; available: readonly PluginListEntry[] }
): PluginListEntry[] {
  const author = pluginAuthor(entry)
  const catalogId = pluginAuthorCatalogId(entry)
  if (!author || !catalogId) {
    return []
  }
  const seen = new Set([entry.pluginKey])
  return [...entries.installed, ...entries.available].filter((other) => {
    if (
      seen.has(other.pluginKey) ||
      pluginAuthorCatalogId(other) !== catalogId ||
      other.publisher !== author.publisher
    ) {
      return false
    }
    seen.add(other.pluginKey)
    return true
  })
}
