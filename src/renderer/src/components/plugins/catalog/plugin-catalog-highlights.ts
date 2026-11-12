import { needsNewerOrca, type PluginListEntry } from '../list/plugin-list-entries'
import { pluginFilterKinds } from '../list/plugin-list-filter'
import { pickNewPlugins } from '../../../../../shared/plugins/catalog/plugin-added-at'
import { pluginListedAt } from '../list/plugin-listed-at'

/**
 * Cards the Featured row offers; the grid shows as many as fit one row (1–4 columns).
 * Why a cap: Featured is a responsive teaser, not an exhaustive one-per-category list.
 */
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

/**
 * Most installed first, one per kind, so a single popular kind can't fill the row. A plugin counts
 * for every kind it belongs to, as the category filters do, and fills one of them: the kind with
 * the fewest lower-ranked candidates left, so a multi-kind plugin doesn't take a kind's only
 * candidate's place. Ties break by key and kind name, never by category order, so results stay put.
 */
export function pickFeaturedPlugins(
  entries: readonly PluginListEntry[],
  installCounts: Readonly<Record<string, number>>,
  orcaVersion: string | null
): PluginListEntry[] {
  const counted = entries
    .filter((entry) => entry.installCountEligible && isOfferable(entry, orcaVersion))
    .flatMap((entry) => {
      const count = installCounts[entry.pluginKey]
      return typeof count === 'number' && count > 0
        ? [{ entry, count, kinds: [...pluginFilterKinds(entry)].sort() }]
        : []
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.entry.pluginKey < b.entry.pluginKey ? -1 : a.entry.pluginKey > b.entry.pluginKey ? 1 : 0)
    )
  const candidatesLeft = new Map<string, number>()
  for (const { kinds } of counted) {
    for (const kind of kinds) {
      candidatesLeft.set(kind, (candidatesLeft.get(kind) ?? 0) + 1)
    }
  }
  const kindsFilled = new Set<string>()
  const featured: PluginListEntry[] = []
  for (const { entry, kinds } of counted) {
    let pick: string | undefined
    let pickLeft = Infinity
    for (const kind of kinds) {
      const left = (candidatesLeft.get(kind) ?? 1) - 1
      candidatesLeft.set(kind, left)
      // Why strict <: kinds are sorted, so an equal count keeps the alphabetically first kind.
      if (!kindsFilled.has(kind) && left < pickLeft) {
        pick = kind
        pickLeft = left
      }
    }
    if (pick === undefined) {
      continue
    }
    kindsFilled.add(pick)
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

/**
 * The highlight rows; Featured never shows without Newly added. Why: alone, Featured sits right on
 * the catalogs, whose leading cards are the same popular plugins in the same columns, so the
 * repeat reads as a render bug. Dropping those plugins from their catalog instead would move a
 * card into the catalog the moment it's installed, and skew the catalog's "N of M".
 */
export function pickCatalogHighlights(
  entries: readonly PluginListEntry[],
  installCounts: Readonly<Record<string, number>>,
  orcaVersion: string | null,
  now: number
): { featured: PluginListEntry[]; newlyAdded: PluginListEntry[] } {
  const newlyAdded = pickNewlyAddedPlugins(entries, orcaVersion, now)
  return {
    featured: newlyAdded.length > 0 ? pickFeaturedPlugins(entries, installCounts, orcaVersion) : [],
    newlyAdded
  }
}
