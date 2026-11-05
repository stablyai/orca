const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/

function parseIsoTimestamp(value: string): number {
  const match = ISO_TIMESTAMP.exec(value)
  if (!match) {
    return Number.NaN
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59))
  ) {
    return Number.NaN
  }
  return Date.parse(value)
}

export function parseScheduledWaitUntil(value: string, now = Date.now()): string {
  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  const timestamp = duration
    ? now + Number(duration[1]) * DURATION_UNITS[duration[2]]
    : parseIsoTimestamp(value)
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > 8_640_000_000_000_000) {
    throw new Error(
      'wait-until must be a future ISO timestamp with timezone or a positive duration (30s, 5m, 4h, 1d).'
    )
  }
  return new Date(timestamp).toISOString()
}
