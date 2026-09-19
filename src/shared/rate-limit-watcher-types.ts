/** Terminals the user armed the rate-limit watcher on, by tab id.
 *
 *  Scoped to a terminal rather than a workspace because that is the unit the
 *  watcher actually acts on: one tab runs one agent, and a workspace commonly
 *  has several — arming all of them to reach one is the wrong bargain for a
 *  feature that presses keys unattended.
 *
 *  Tab ids rather than pty ids: a PTY is replaced across restarts and respawns,
 *  and the box is ticked long before the stall it is meant to catch. */
export type RateLimitWatcherSnapshot = {
  tabIds: string[]
}

/** Bound on the armed-tab list. Closed tab ids are never reused, so without a
 *  ceiling the set would only ever grow. */
export const MAX_RATE_LIMIT_WATCHER_TABS = 200

/** Applies that bound — and the element type — on load as well as on write.
 *  orca-data.json is a plaintext file: a hand-edited or downgrade-mangled array
 *  can carry non-strings that every consumer here treats as tab ids, and a list
 *  written before the cap existed would otherwise stay unbounded forever, since
 *  the writer only trims the slice it is already rewriting. */
export function normalizeRateLimitWatcherTabs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const tabIds = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  // Newest last, matching the writer: an over-long list loses its oldest tabs.
  return [...new Set(tabIds)].slice(-MAX_RATE_LIMIT_WATCHER_TABS)
}
