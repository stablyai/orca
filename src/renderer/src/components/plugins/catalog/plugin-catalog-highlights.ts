import { needsNewerOrca, type PluginListEntry } from '../list/plugin-list-entries'
import { pluginFilterKinds } from '../list/plugin-list-filter'
import { PLUGIN_ADDED_THIS_WEEK_MS, pluginListedAgoMs } from '../list/plugin-listed-at'

const DAY_MS = 24 * 60 * 60 * 1000

/** Cards a highlight row offers; the grid shows as many as fit one row (1–4 columns). */
export const PLUGIN_HIGHLIGHT_ROW_LIMIT = 4
// Why a window: a catalog that stopped adding plugins shouldn't call months-old ones new.
const PLUGIN_NEWLY_ADDED_WINDOW_MS = 14 * DAY_MS

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
    if (featured.length === PLUGIN_HIGHLIGHT_ROW_LIMIT) {
      break
    }
  }
  return featured
}

export type NewlyAddedPlugins = {
  rows: PluginListEntry[]
  /** Every listed plugin added in the last week, installed or not, for "N this week". */
  thisWeek: number
}

/** Newest listings first. Null hides the row: no catalog dates its entries, or none recently. */
export function pickNewlyAddedPlugins(
  entries: readonly PluginListEntry[],
  orcaVersion: string | null,
  now: number
): NewlyAddedPlugins | null {
  const recent = entries
    .flatMap((entry) => {
      const ago = pluginListedAgoMs(entry, now)
      return ago !== null && ago <= PLUGIN_NEWLY_ADDED_WINDOW_MS ? [{ entry, ago }] : []
    })
    .sort((a, b) => a.ago - b.ago)
  const rows = recent
    .filter(({ entry }) => isOfferable(entry, orcaVersion))
    .slice(0, PLUGIN_HIGHLIGHT_ROW_LIMIT)
    .map(({ entry }) => entry)
  if (rows.length === 0) {
    return null
  }
  return { rows, thisWeek: recent.filter(({ ago }) => ago <= PLUGIN_ADDED_THIS_WEEK_MS).length }
}
