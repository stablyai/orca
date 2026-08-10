const MILLISECONDS_PER_DAY = 86_400_000
const SECONDS_PER_DAY = 86_400
// Why: Excel's 1900 date system treats 1900 as a leap year for Lotus 1-2-3
// compatibility, so serial 60 is the non-existent 1900-02-29 and every serial
// above it is shifted one day. Anchoring at 1899-12-30 absorbs that shift for
// serials >= 61; serials 1..59 are anchored at 1899-12-31 instead.
const DAY_ZERO_1900_UTC = Date.UTC(1899, 11, 30)
const DAY_ZERO_1900_PRE_LEAP_BUG_UTC = Date.UTC(1899, 11, 31)
const DAY_ZERO_1904_UTC = Date.UTC(1904, 0, 1)
const PHANTOM_LEAP_DAY_SERIAL = 60
const PHANTOM_LEAP_DAY_TEXT = '1900-02-29'

export type XlsxDateSystem = { use1904DateSystem: boolean }

/**
 * Renders a stored date/time serial as an ISO-like string: `YYYY-MM-DD` for a
 * whole day, `YYYY-MM-DD HH:MM:SS` when it carries a time, and `HH:MM:SS` for a
 * time-only value.
 *
 * Returns null when the serial is outside the range Excel can store, so the
 * caller can fall back to the raw value instead of inventing a date.
 */
export function formatXlsxSerialDate(
  serial: number,
  { use1904DateSystem }: XlsxDateSystem
): string | null {
  if (!Number.isFinite(serial) || serial < 0) {
    return null
  }

  const roundedSeconds = Math.round((serial - Math.floor(serial)) * SECONDS_PER_DAY)
  // Why: rounding a fraction like 0.99999 up lands on 24:00:00, which belongs to
  // the next day rather than an out-of-range hour.
  const carriedDays = Math.floor(roundedSeconds / SECONDS_PER_DAY)
  const secondsOfDay = roundedSeconds - carriedDays * SECONDS_PER_DAY
  const days = Math.floor(serial) + carriedDays
  const timeText = formatTimeOfDay(secondsOfDay)

  if (days === 0 && !use1904DateSystem) {
    // Why: Excel shows serial fractions below 1 as a bare time in the 1900
    // system — there is no day 0 date to pair them with.
    return timeText
  }
  if (days === PHANTOM_LEAP_DAY_SERIAL && !use1904DateSystem) {
    return secondsOfDay === 0 ? PHANTOM_LEAP_DAY_TEXT : `${PHANTOM_LEAP_DAY_TEXT} ${timeText}`
  }

  const dayZeroUtc = use1904DateSystem
    ? DAY_ZERO_1904_UTC
    : days < PHANTOM_LEAP_DAY_SERIAL
      ? DAY_ZERO_1900_PRE_LEAP_BUG_UTC
      : DAY_ZERO_1900_UTC
  const date = new Date(dayZeroUtc + days * MILLISECONDS_PER_DAY)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  const dateText = `${padNumber(date.getUTCFullYear(), 4)}-${padNumber(date.getUTCMonth() + 1, 2)}-${padNumber(date.getUTCDate(), 2)}`
  return secondsOfDay === 0 ? dateText : `${dateText} ${timeText}`
}

function formatTimeOfDay(secondsOfDay: number): string {
  const hours = Math.floor(secondsOfDay / 3600)
  const minutes = Math.floor((secondsOfDay % 3600) / 60)
  const seconds = secondsOfDay % 60
  return `${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}`
}

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, '0')
}
