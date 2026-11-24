// How the Automations card words when things run and ran.
import { translate } from '@/i18n/i18n'
import { formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import {
  LOOK_AROUND_EVERY,
  lookedDay,
  type BotLookAround
} from '../../../../shared/bots/bot-look-around'
import { formatWaitTime } from './bot-wait-copy'

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const
const CLOCK_DATE = { month: 'short', day: 'numeric' } as const

/** "Today at 4:00 PM", "Tomorrow at 9:00 AM", then the day: "Fri 5 PM", "Nov 14, 5 PM". */
export function upcomingAt(at: number, now = Date.now()): string {
  const time = uiDateTimeFormat(CLOCK).format(at)
  if (lookedDay(at, now) === 'today') {
    return translate('bots.upcoming.today', 'Today at {{time}}', { time })
  }
  // Tomorrow is the day whose yesterday is today.
  return lookedDay(now, at) === 'yesterday'
    ? translate('bots.upcoming.tomorrow', 'Tomorrow at {{time}}', { time })
    : formatWaitTime(at, now)
}

const HOUR = { hour: 'numeric' } as const
const WEEKDAY_CLOCK = { weekday: 'short', ...CLOCK } as const
const WEEKDAY_HOUR = { weekday: 'short', ...HOUR } as const
const WEEKDAY = { weekday: 'short' } as const
const MINUTE_MS = 60_000

/** Calendar days from `now`'s day to `at`'s, so a daylight-saving day still counts as one. */
function daysAhead(at: number, now: number): number {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  const to = new Date(at)
  to.setHours(0, 0, 0, 0)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/** A row's next run, short enough for its end: "in 12m", "6:30 PM" or "3 PM" today, "Thu 3 AM"
 *  tomorrow (never read as today), "Fri" within the week, then "Nov 24". */
export function upcomingShort(at: number, now = Date.now()): string {
  const ahead = at - now
  if (ahead < 60 * MINUTE_MS) {
    return formatUiNarrowRelativeTime(
      Math.min(59, Math.max(1, Math.ceil(ahead / MINUTE_MS))),
      'minute'
    )
  }
  const onTheHour = new Date(at).getMinutes() === 0
  const days = daysAhead(at, now)
  const options =
    days === 0
      ? onTheHour
        ? HOUR
        : CLOCK
      : days === 1
        ? onTheHour
          ? WEEKDAY_HOUR
          : WEEKDAY_CLOCK
        : days <= 6
          ? WEEKDAY
          : CLOCK_DATE
  return uiDateTimeFormat(options).format(at)
}

function hourText(hour: number): string {
  const at = new Date()
  at.setHours(hour, 0, 0, 0)
  return uiDateTimeFormat(HOUR).format(at)
}

/** The setting's real schedule: "weekdays, 8 AM to 8 PM, every 4 hours", "each morning at 8 AM". */
export function everyText(setting: Pick<BotLookAround, 'every' | 'weekdaysOnly'>): string {
  const hours = LOOK_AROUND_EVERY[setting.every]
  const first = hourText(hours[0] ?? 0)
  const last = hourText(hours.at(-1) ?? 0)
  const schedule = ((): string => {
    switch (setting.every) {
      case 'every-4h':
        return translate('bots.upcoming.every4hWindow', '{{from}} to {{to}}, every 4 hours', {
          from: first,
          to: last
        })
      case 'every-2h':
        return translate('bots.upcoming.every2hWindow', '{{from}} to {{to}}, every 2 hours', {
          from: first,
          to: last
        })
      case 'twice-daily':
        return translate('bots.upcoming.twiceDailyAt', 'twice a day, {{first}} and {{second}}', {
          first,
          second: last
        })
      case 'mornings':
        return translate('bots.upcoming.morningsAt', 'each morning at {{time}}', { time: first })
    }
  })()
  return setting.weekdaysOnly
    ? translate('bots.upcoming.weekdays', 'weekdays, {{schedule}}', { schedule })
    : schedule
}

export const pausedText = (): string => translate('bots.automations.paused', 'Paused')

/** "Ran 6:00 PM" today, "Ran yesterday", then "Ran Nov 11". */
export function ranText(at: number, now = Date.now()): string {
  const day = lookedDay(at, now)
  if (day === 'today') {
    return translate('bots.automations.ranAt', 'Ran {{time}}', {
      time: uiDateTimeFormat(CLOCK).format(at)
    })
  }
  return day === 'yesterday'
    ? translate('bots.automations.ranYesterday', 'Ran yesterday')
    : translate('bots.automations.ranAt', 'Ran {{time}}', {
        time: uiDateTimeFormat(CLOCK_DATE).format(at)
      })
}
