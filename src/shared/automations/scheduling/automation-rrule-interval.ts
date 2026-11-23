const MAX_RRULE_INTERVAL = 52

/** INTERVAL as the scheduler runs it, plus the part new input must refuse when it can't run as written. */
export function readRruleInterval(
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY',
  entries: ReadonlyMap<string, string>
): { interval: number; ignoredPart: string | null } {
  const raw = entries.get('INTERVAL') ?? '1'
  const interval = Number(raw)
  if (!/^\d+$/.test(raw) || interval < 1 || interval > MAX_RRULE_INTERVAL) {
    // Stored rules keep running every period, as they did before INTERVAL was read.
    return { interval: 1, ignoredPart: `INTERVAL=${raw}` }
  }
  // Interval weeks start on Monday, so another week start would shift which weeks run.
  const wkst = entries.get('WKST')
  const shiftsWeeks = freq === 'WEEKLY' && interval > 1 && wkst !== undefined && wkst !== 'MO'
  return { interval, ignoredPart: shiftsWeeks ? `WKST=${wkst}` : null }
}
