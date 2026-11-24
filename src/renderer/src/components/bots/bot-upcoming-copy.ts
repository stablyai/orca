// How the Automations card words when things run and ran.
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import {
  LOOK_AROUND_EVERY,
  lookedDay,
  type BotLookAround
} from '../../../../shared/bots/bot-look-around'
import { formatWaitTime } from './bot-wait-copy'

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

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

const CLOCK_DATE = { month: 'short', day: 'numeric' } as const

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
