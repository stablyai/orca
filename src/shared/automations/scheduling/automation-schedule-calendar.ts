// The wall clock a schedule's hours and days are read in: the automation's own timezone, so a host
// in another zone (a paired server, an SSH box, a travelling laptop) runs it when its owner meant.
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
// Offsets change on quarter-hour instants, so one lookup serves each quarter hour.
const OFFSET_BUCKET_MS = 15 * MINUTE_MS
const OFFSET_CACHE_SIZE = 1024

export type ScheduleWallTime = {
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
}

export type ScheduleCalendar = {
  fields: (timestamp: number) => ScheduleWallTime
  startOfDay: (timestamp: number) => number
  /** Calendar steps, not 24h ones; DST days are not 24 hours long. */
  addDays: (day: number, days: number) => number
  atTime: (day: number, hour: number, minute: number) => number
}

export const LOCAL_SCHEDULE_CALENDAR: ScheduleCalendar = {
  fields: (timestamp) => {
    const date = new Date(timestamp)
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes()
    }
  },
  startOfDay: (timestamp) => {
    const date = new Date(timestamp)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  },
  addDays: (day, days) => {
    const date = new Date(day)
    date.setDate(date.getDate() + days)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  },
  atTime: (day, hour, minute) => {
    const date = new Date(day)
    date.setHours(hour, minute, 0, 0)
    return date.getTime()
  }
}

function zonedCalendar(timeZone: string): ScheduleCalendar {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  })
  const offsets = new Map<number, number>()
  // Wall time minus the instant, in ms; cached because a cron scan asks once per minute.
  const offsetAt = (timestamp: number): number => {
    const bucket = Math.floor(timestamp / OFFSET_BUCKET_MS)
    let offset = offsets.get(bucket)
    if (offset === undefined) {
      const parts = Object.fromEntries(
        format.formatToParts(bucket * OFFSET_BUCKET_MS).map((part) => [part.type, part.value])
      )
      const wall = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute)
      )
      offset = wall - bucket * OFFSET_BUCKET_MS
      if (offsets.size >= OFFSET_CACHE_SIZE) {
        offsets.clear()
      }
      offsets.set(bucket, offset)
    }
    return offset
  }
  const wallOf = (timestamp: number) => new Date(timestamp + offsetAt(timestamp))
  // As local Date math resolves it: a skipped time moves forward, a repeated one takes the first.
  const instantOf = (wall: number): number => {
    const before = offsetAt(wall - DAY_MS)
    const after = offsetAt(wall + DAY_MS)
    const early = wall - before
    const late = wall - after
    const earlyFits = offsetAt(early) === before
    const lateFits = offsetAt(late) === after
    if (earlyFits && lateFits) {
      return Math.min(early, late)
    }
    return lateFits && !earlyFits ? late : early
  }
  const wallMidnight = (timestamp: number) => {
    const wall = timestamp + offsetAt(timestamp)
    return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS)
  }
  return {
    fields: (timestamp) => {
      const wall = wallOf(timestamp)
      return {
        month: wall.getUTCMonth() + 1,
        day: wall.getUTCDate(),
        weekday: wall.getUTCDay(),
        hour: wall.getUTCHours(),
        minute: wall.getUTCMinutes()
      }
    },
    startOfDay: (timestamp) => instantOf(wallMidnight(timestamp)),
    addDays: (day, days) => instantOf(wallMidnight(day) + days * DAY_MS),
    atTime: (day, hour, minute) =>
      instantOf(wallMidnight(day) + hour * 60 * MINUTE_MS + minute * MINUTE_MS)
  }
}

/** Whether Intl knows the zone; a schedule stored in an unknown one runs on the host's clock. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function unknownTimeZoneMessage(timeZone: string): string {
  return `Unknown time zone ${JSON.stringify(timeZone)}; use an IANA name like America/New_York.`
}

/** The host's own clock when the zone is absent, unknown, or the host's; otherwise that zone's. */
export function automationScheduleCalendar(timeZone: string | undefined): ScheduleCalendar {
  if (!timeZone || timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone) {
    return LOCAL_SCHEDULE_CALENDAR
  }
  try {
    return zonedCalendar(timeZone)
  } catch {
    // An unknown zone (an older host's or a hand-edited one) keeps the behaviour it always had.
    return LOCAL_SCHEDULE_CALENDAR
  }
}
