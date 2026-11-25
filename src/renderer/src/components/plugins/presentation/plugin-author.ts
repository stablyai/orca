// @protected-copy
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { pluginEntryManagingTeams, type PluginListEntry } from '../list/plugin-list-entries'
import { LOCAL_PLUGIN_PUBLISHER } from '../../../../../shared/plugins/installation/plugin-publisher-derivation'
import { sanitizePluginDisplayText } from '../../../../../shared/plugins/manifest/plugin-display-text'

export type PluginAuthor = {
  publisher: string
  catalog: string | null
  provenance: 'catalog' | 'git' | 'manifest' | 'unknown'
}

function managingTeamNames(teams: string[]): string {
  return [
    ...new Set(teams.map((name) => sanitizePluginDisplayText(name).trim()).filter(Boolean))
  ].join(', ')
}

export function managedCatalogLabel(teams: string[], t: Translate): string {
  const names = managingTeamNames(teams)
  return names
    ? t('plugins.catalog.managedByNamedTeams', 'Managed by {{teams}}', { teams: names })
    : t('plugins.catalog.managedByTeam', 'Managed by your team')
}

export function pluginDisplayPublisher(entry: PluginListEntry, t: Translate): string | null {
  const teams = pluginEntryManagingTeams(entry)
  return teams
    ? managingTeamNames(teams) || t('plugins.catalog.teamPublisher', 'Your team')
    : entry.publisher
}

export function pluginAuthor(
  entry: PluginListEntry,
  t: Translate = translate
): PluginAuthor | null {
  const publisher = pluginDisplayPublisher(entry, t)
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
  const managed = Boolean(pluginEntryManagingTeams(entry))
  const seen = new Set([entry.pluginKey])
  return [...entries.installed, ...entries.available].filter((other) => {
    if (
      seen.has(other.pluginKey) ||
      pluginAuthorCatalogId(other) !== catalogId ||
      (managed ? !pluginEntryManagingTeams(other) : other.publisher !== entry.publisher)
    ) {
      return false
    }
    seen.add(other.pluginKey)
    return true
  })
}
