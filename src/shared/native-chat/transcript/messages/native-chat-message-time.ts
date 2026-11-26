import {
  createRegionalDateTimeFormat,
  osDateTimeRegionKey
} from '../../../i18n/regional-date-time-format'

const timeFormat: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit'
}

function createNativeChatMessageTimeFormatter(locale: string | undefined, timeZone: string) {
  const time = createRegionalDateTimeFormat({ ...timeFormat, timeZone }, locale)
  const dateOptions: Intl.DateTimeFormatOptions = {
    ...timeFormat,
    timeZone,
    month: 'short',
    day: 'numeric'
  }
  const dateTime = createRegionalDateTimeFormat(dateOptions, locale)
  const dateTimeWithYear = createRegionalDateTimeFormat({ ...dateOptions, year: 'numeric' }, locale)
  const full = createRegionalDateTimeFormat(
    { dateStyle: 'full', timeStyle: 'long', timeZone },
    locale
  )
  const day = createRegionalDateTimeFormat({ timeZone, month: 'short', day: 'numeric' }, locale)
  const dayWithYear = createRegionalDateTimeFormat(
    {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    },
    locale
  )

  return {
    /** `yesterday` wraps the time in the UI language's "Yesterday {{time}}"; without it, yesterday shows its date. */
    format(date: Date, now = new Date(), yesterday?: (time: string) => string): string {
      if (date.toDateString() === now.toDateString()) {
        return time.format(date)
      }
      if (yesterday) {
        const dayBefore = new Date(now)
        dayBefore.setDate(now.getDate() - 1)
        if (date.toDateString() === dayBefore.toDateString()) {
          return yesterday(time.format(date))
        }
      }
      return date.getFullYear() === now.getFullYear()
        ? dateTime.format(date)
        : dateTimeWithYear.format(date)
    },
    /** For a narrow column: today's time, else only the day. */
    formatCompact(date: Date, now = new Date()): string {
      if (date.toDateString() === now.toDateString()) {
        return time.format(date)
      }
      return date.getFullYear() === now.getFullYear() ? day.format(date) : dayWithYear.format(date)
    },
    formatFull(date: Date): string {
      return full.format(date)
    }
  }
}

type NativeChatMessageDay = { date: Date; timeZone: string }

let daySnapshot: NativeChatMessageDay | null = null
let checkedAt: number | null = null

export function getNativeChatMessageDay(now: number): NativeChatMessageDay {
  if (daySnapshot && checkedAt === now) {
    return daySnapshot
  }
  const date = new Date(now)
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  checkedAt = now
  if (
    !daySnapshot ||
    daySnapshot.date.toDateString() !== date.toDateString() ||
    daySnapshot.timeZone !== timeZone
  ) {
    daySnapshot = { date, timeZone }
  }
  return daySnapshot
}

let cached: {
  locale: string | undefined
  timeZone: string
  region: string
  formatter: ReturnType<typeof createNativeChatMessageTimeFormatter>
} | null = null

export function getNativeChatMessageTimeFormatter(
  locale?: string,
  { timeZone } = getNativeChatMessageDay(Date.now())
) {
  const region = osDateTimeRegionKey()
  if (
    !cached ||
    cached.locale !== locale ||
    cached.timeZone !== timeZone ||
    cached.region !== region
  ) {
    cached = {
      locale,
      timeZone,
      region,
      formatter: createNativeChatMessageTimeFormatter(locale, timeZone)
    }
  }
  return cached.formatter
}
