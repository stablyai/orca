import type { PluginListEntry } from './plugin-list-entries'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api/plugins/plugin-host-api'

export type PluginCatalogSort =
  | 'default'
  | 'most-installed'
  | 'recently-added'
  | 'recently-updated'
  | 'name'

export type PluginCatalogSortEntry = Pick<PluginListEntry, 'pluginKey' | 'name'> & {
  listing: Pick<PluginMarketplaceHostListing, 'addedAt' | 'updatedAt'> | null
}

export type PluginCatalogComparator = (
  left: PluginCatalogSortEntry,
  right: PluginCatalogSortEntry,
  installCounts?: Readonly<Record<string, number>>
) => number

function comparePluginKeys(left: PluginCatalogSortEntry, right: PluginCatalogSortEntry): number {
  return left.pluginKey < right.pluginKey ? -1 : left.pluginKey > right.pluginKey ? 1 : 0
}

function compareDates(
  leftValue: string | undefined,
  rightValue: string | undefined,
  left: PluginCatalogSortEntry,
  right: PluginCatalogSortEntry
): number {
  if (leftValue === undefined) {
    return rightValue === undefined ? comparePluginKeys(left, right) : 1
  }
  if (rightValue === undefined) {
    return -1
  }
  return (
    (rightValue < leftValue ? -1 : rightValue > leftValue ? 1 : 0) || comparePluginKeys(left, right)
  )
}

export function isPluginCatalogSort(value: string): value is PluginCatalogSort {
  return (
    value === 'default' ||
    value === 'most-installed' ||
    value === 'recently-added' ||
    value === 'recently-updated' ||
    value === 'name'
  )
}

export const pluginCatalogComparators: Record<
  Exclude<PluginCatalogSort, 'default'>,
  PluginCatalogComparator
> = {
  'most-installed': (left, right, installCounts) =>
    (installCounts?.[right.pluginKey] ?? 0) - (installCounts?.[left.pluginKey] ?? 0) ||
    comparePluginKeys(left, right),
  'recently-added': (left, right) =>
    compareDates(left.listing?.addedAt, right.listing?.addedAt, left, right),
  'recently-updated': (left, right) =>
    compareDates(left.listing?.updatedAt, right.listing?.updatedAt, left, right),
  name: (left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
    comparePluginKeys(left, right)
}
