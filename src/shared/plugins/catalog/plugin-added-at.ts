// When a catalog plugin was listed, and the Newly added row built from it. Mirrors the website's
// derivation (orca-site src/lib/plugins/pluginCatalog.ts and pluginNew.ts) so both show the same
// plugins with the same ages. Catalogs carry no listing date; it is estimated from release dates.

/** Cards the Newly added row may hold. */
export const PLUGIN_NEW_LIMIT = 9
/** Older listings aren't "new"; the row hides once nothing falls inside this window. */
export const PLUGIN_NEW_WINDOW_DAYS = 30

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
// Why: a date this far ahead of the local clock is wrong data, not skew, and is never shown.
const FUTURE_SKEW_MS = HOUR_MS

/**
 * A community plugin's oldest dated release stands in for its listing date. Catalogs keep only
 * recent releases, so this can be later than the real listing date, never earlier. Official
 * releases carry no dates, so official plugins stay undated (null).
 */
export function estimatePluginAddedAt(
  releases: readonly { updatedAt?: string }[] | undefined,
  official: boolean
): string | null {
  if (official || !releases) {
    return null
  }
  const times = releases.flatMap((release) => {
    const time = release.updatedAt ? Date.parse(release.updatedAt) : Number.NaN
    return Number.isNaN(time) ? [] : [time]
  })
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : null
}

/** Milliseconds since `addedAt`, or null when it is missing, malformed or in the future. */
export function pluginAddedAgeMs(addedAt: string | null | undefined, now: number): number | null {
  if (!addedAt) {
    return null
  }
  const time = Date.parse(addedAt)
  if (Number.isNaN(time) || time - now > FUTURE_SKEW_MS) {
    return null
  }
  return Math.max(0, now - time)
}

export type NewPlugins<T> = { items: T[]; addedThisWeek: number }

/** Newest listings first, within the window. Items without a usable date never appear. */
export function pickNewPlugins<T>(
  items: readonly T[],
  addedAtOf: (item: T) => string | null | undefined,
  now: number,
  { limit = PLUGIN_NEW_LIMIT, windowDays = PLUGIN_NEW_WINDOW_DAYS } = {}
): NewPlugins<T> {
  const recent = items.flatMap((item) => {
    const age = pluginAddedAgeMs(addedAtOf(item), now)
    return age !== null && age <= windowDays * DAY_MS ? [{ item, age }] : []
  })
  return {
    items: recent
      .sort((a, b) => a.age - b.age)
      .slice(0, limit)
      .map(({ item }) => item),
    addedThisWeek: recent.filter(({ age }) => age <= 7 * DAY_MS).length
  }
}

/**
 * "just now", "3 hours ago", "1 day ago"; the absolute date once it is two months old. Null for a
 * missing, malformed or future date. Defaults read exactly like the website; pass the UI locale
 * and a translated `justNow` to localize.
 */
export function formatAddedAgo(
  addedAt: string,
  now: number,
  { locale = 'en-US', justNow = 'just now' }: { locale?: string; justNow?: string } = {}
): string | null {
  const age = pluginAddedAgeMs(addedAt, now)
  if (age === null) {
    return null
  }
  if (age < HOUR_MS) {
    return justNow
  }
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
  if (age < DAY_MS) {
    return relative.format(-Math.floor(age / HOUR_MS), 'hour')
  }
  const days = Math.floor(age / DAY_MS)
  if (days < 60) {
    return relative.format(-days, 'day')
  }
  return new Date(Date.parse(addedAt)).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })
}
