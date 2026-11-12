import type { PluginListEntry } from './plugin-list-entries'

/** The plugin's estimated listing date (ISO 8601), when main could estimate one. */
export function pluginListedAt(entry: PluginListEntry): string | undefined {
  return entry.listing?.addedAt
}
