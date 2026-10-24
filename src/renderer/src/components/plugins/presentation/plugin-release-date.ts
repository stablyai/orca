/** A catalog release date ("2026-10-20" or a date-time) as a short local date; null if unreadable. */
export function formatPluginReleaseDate(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    // Why: a bare date parses as UTC midnight, which is the previous day west of UTC.
    ...(dateOnly ? { timeZone: 'UTC' } : {})
  }).format(date)
}
