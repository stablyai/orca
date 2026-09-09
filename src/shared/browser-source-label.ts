import { BROWSER_FAMILY_LABELS } from './constants'
import type { BrowserSessionProfileSource } from './browser-workspace-types'

// Resolve a profile source to its user-facing browser name. A per-entry
// sourceLabel wins (auto-discovered/custom browsers all share family 'custom'),
// then the family label map, then the raw family string as a last resort.
export function browserSourceLabel(source: BrowserSessionProfileSource): string {
  return source.sourceLabel ?? BROWSER_FAMILY_LABELS[source.browserFamily] ?? source.browserFamily
}
