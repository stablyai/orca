import { pluginAddedAgeMs } from '../../../../../shared/plugins/catalog/plugin-added-at'
import type { PluginListEntry } from './plugin-list-entries'

const DAY_MS = 24 * 60 * 60 * 1000

/** Plugins listed this recently get the New badge, in the Newly added row and in the catalog grid. */
export const PLUGIN_NEW_BADGE_MS = DAY_MS
/** "See all" on the Newly added row and the Added this week filter. */
export const PLUGIN_ADDED_THIS_WEEK_MS = 7 * DAY_MS

/** The plugin's estimated listing date (ISO 8601), when main could estimate one. */
export function pluginListedAt(entry: PluginListEntry): string | undefined {
  return entry.listing?.addedAt
}

export function isPluginListedWithin(
  entry: PluginListEntry,
  windowMs: number,
  now: number
): boolean {
  const age = pluginAddedAgeMs(pluginListedAt(entry), now)
  return age !== null && age <= windowMs
}
