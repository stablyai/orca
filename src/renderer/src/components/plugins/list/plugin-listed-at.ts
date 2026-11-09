import type { PluginListEntry } from './plugin-list-entries'

const DAY_MS = 24 * 60 * 60 * 1000

/** Plugins listed this recently get the New badge, in the Newly added row and in the catalog grid. */
export const PLUGIN_NEW_BADGE_MS = DAY_MS
/** "See all" on the Newly added row and the Added this week filter. */
export const PLUGIN_ADDED_THIS_WEEK_MS = 7 * DAY_MS

/** Milliseconds since the catalog listed the plugin; null when it doesn't say or the date is bad. */
export function pluginListedAgoMs(entry: PluginListEntry, now: number): number | null {
  const addedAt = entry.listing?.addedAt
  const time = addedAt ? Date.parse(addedAt) : Number.NaN
  return Number.isNaN(time) ? null : Math.max(0, now - time)
}

export function isPluginListedWithin(
  entry: PluginListEntry,
  windowMs: number,
  now: number
): boolean {
  const ago = pluginListedAgoMs(entry, now)
  return ago !== null && ago <= windowMs
}
