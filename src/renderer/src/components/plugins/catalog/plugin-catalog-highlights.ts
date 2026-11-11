import { needsNewerOrca, type PluginListEntry } from '../list/plugin-list-entries'
import { pluginFilterKinds } from '../list/plugin-list-filter'
import { pickNewPlugins } from '../../../../../shared/plugins/catalog/plugin-added-at'
import { pluginListedAt } from '../list/plugin-listed-at'

/** Cards the Featured row offers; the grid shows as many as fit one row (1–4 columns). */
export const PLUGIN_FEATURED_LIMIT = 4

/** A plugin someone could install from a highlight row right now. */
function isOfferable(entry: PluginListEntry, orcaVersion: string | null): boolean {
  const listing = entry.listing
  return Boolean(
    listing &&
    !entry.installed &&
    !listing.blockedByKillList &&
    !needsNewerOrca(entry.minimumOrca, orcaVersion)
  )
}

/** Most installed first, one per kind, so a single popular kind can't fill the row. */
export function pickFeaturedPlugins(
  entries: readonly PluginListEntry[],
  installCounts: Readonly<Record<string, number>>,
  orcaVersion: string | null
): PluginListEntry[] {
  const counted = entries
    .filter((entry) => entry.installCountEligible && isOfferable(entry, orcaVersion))
    .flatMap((entry) => {
      const count = installCounts[entry.pluginKey]
      return typeof count === 'number' && count > 0 ? [{ entry, count }] : []
    })
    .sort((a, b) => b.count - a.count)
  const kindsShown = new Set<string>()
  const featured: PluginListEntry[] = []
  for (const { entry } of counted) {
    const [kind] = pluginFilterKinds(entry)
    if (kind === undefined || kindsShown.has(kind)) {
      continue
    }
    kindsShown.add(kind)
    featured.push(entry)
    if (featured.length === PLUGIN_FEATURED_LIMIT) {
      break
    }
  }
  return featured
}

/**
 * Newest listings first, inside the website's 30-day window, up to the website's nine. Empty hides
 * the row: no plugin has an estimated listing date, or none is recent and installable.
 */
export function pickNewlyAddedPlugins(
  entries: readonly PluginListEntry[],
  orcaVersion: string | null,
  now: number
): PluginListEntry[] {
  return pickNewPlugins(
    entries.filter((entry) => isOfferable(entry, orcaVersion)),
    pluginListedAt,
    now
  )
}
