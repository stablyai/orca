// How the Automations card words when things run and ran.
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { lookedDay, type LookAroundEvery } from '../../../../shared/bots/bot-look-around'
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

export function everyText(every: LookAroundEvery): string {
  switch (every) {
    case 'every-4h':
      return translate('bots.upcoming.every4h', 'every 4 hours')
    case 'every-2h':
      return translate('bots.upcoming.every2h', 'every 2 hours')
    case 'twice-daily':
      return translate('bots.upcoming.twiceDaily', 'twice a day')
    case 'mornings':
      return translate('bots.upcoming.mornings', 'each morning')
  }
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
