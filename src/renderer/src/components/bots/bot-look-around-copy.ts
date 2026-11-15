// Look around's schedule in the viewer's words: the one formatter Settings, the Activity row and the
// sidebar card share, so they never say different things.
import { getIntlLocale, translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { BotLookAround, LookAroundPreset } from '../../../../shared/bots/bot-look-around'

const HOUR_ONLY = { hour: 'numeric' } as const
const HOUR_MINUTE = { hour: 'numeric', minute: '2-digit' } as const

/** The viewer's own zone. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** "9 AM", "9:30 AM": a schedule's wall-clock time, whatever its zone. */
export function lookTimeLabel(time: string): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  const date = new Date(2000, 0, 1, hour, minute)
  return uiDateTimeFormat(minute ? HOUR_MINUTE : HOUR_ONLY).format(date)
}

function listOf(parts: string[]): string {
  try {
    return new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(parts)
  } catch {
    return parts.join(', ')
  }
}

/** "Pacific Time", else the IANA name. */
export function timeZoneName(zone: string): string {
  try {
    const name = new Intl.DateTimeFormat(getIntlLocale(), {
      timeZone: zone,
      timeZoneName: 'longGeneric'
    })
      .formatToParts(0)
      .find((part) => part.type === 'timeZoneName')?.value
    return name && !/^GMT[+-]/.test(name) ? name : zone
  } catch {
    return zone
  }
}

function presetText(preset: LookAroundPreset, weekdays: boolean): string {
  switch (preset) {
    case 'every-4h':
      return weekdays
        ? translate(
            'bots.lookAround.schedule.every4hWeekdays',
            'Every 4 hours on weekdays, 8 AM to 8 PM'
          )
        : translate('bots.lookAround.schedule.every4h', 'Every 4 hours, 8 AM to 8 PM')
    case 'every-2h':
      return weekdays
        ? translate(
            'bots.lookAround.schedule.every2hWeekdays',
            'Every 2 hours on weekdays, 8 AM to 8 PM'
          )
        : translate('bots.lookAround.schedule.every2h', 'Every 2 hours, 8 AM to 8 PM')
    case 'twice-daily':
      return weekdays
        ? translate(
            'bots.lookAround.schedule.twiceWeekdays',
            'Twice a day on weekdays, 8 AM and 1 PM'
          )
        : translate('bots.lookAround.schedule.twice', 'Twice a day, 8 AM and 1 PM')
    case 'mornings':
      return weekdays
        ? translate('bots.lookAround.schedule.morningsWeekdays', 'Weekday mornings at 8 AM')
        : translate('bots.lookAround.schedule.mornings', 'Each morning at 8 AM')
  }
}

/** The zone to name beside a schedule's times: only when it isn't the viewer's own. */
export function foreignZone(zone: string | undefined): string | undefined {
  return zone && zone !== viewerTimeZone() ? timeZoneName(zone) : undefined
}

/** "Weekdays at 9:30 AM and 2 PM", "Every 4 hours on weekdays, 8 AM to 8 PM"; `zone` is added in
 *  parentheses when given. */
export function lookAroundScheduleLine(
  setting: Pick<BotLookAround, 'every' | 'times' | 'weekdaysOnly'>,
  zone?: string
): string {
  if (setting.every === 'custom' && !setting.times?.length) {
    return translate('settings.bots.lookAround.customTimes', 'Custom times…')
  }
  const text =
    setting.every === 'custom' && setting.times?.length
      ? setting.weekdaysOnly
        ? translate('bots.lookAround.schedule.customWeekdays', 'Weekdays at {{times}}', {
            times: listOf((setting.times ?? []).toSorted().map(lookTimeLabel))
          })
        : translate('bots.lookAround.schedule.customDaily', 'Every day at {{times}}', {
            times: listOf((setting.times ?? []).toSorted().map(lookTimeLabel))
          })
      : presetText(setting.every === 'custom' ? 'every-4h' : setting.every, setting.weekdaysOnly)
  return zone ? `${text} (${zone})` : text
}

/** The menu's label for a preset. */
export function lookAroundPresetLabel(preset: LookAroundPreset): string {
  return presetText(preset, false)
}

/** The short form compact rows put after the next look: "every 4 hours", "weekdays at 9:30 AM and 2 PM". */
export function lookAroundScheduleShort(
  setting: Pick<BotLookAround, 'every' | 'times' | 'weekdaysOnly'>,
  zone?: string
): string {
  if (setting.every === 'custom' && !setting.times?.length) {
    return translate('settings.bots.lookAround.customTimes', 'Custom times…')
  }
  const every = setting.every
  const text = (() => {
    switch (every) {
      case 'every-4h':
        return translate('bots.upcoming.every4h', 'every 4 hours')
      case 'every-2h':
        return translate('bots.upcoming.every2h', 'every 2 hours')
      case 'twice-daily':
        return translate('bots.upcoming.twiceDaily', 'twice a day')
      case 'mornings':
        return translate('bots.upcoming.mornings', 'each morning')
      case 'custom': {
        const times = listOf((setting.times ?? []).toSorted().map(lookTimeLabel))
        return setting.weekdaysOnly
          ? translate('bots.upcoming.customWeekdays', 'weekdays at {{times}}', { times })
          : translate('bots.upcoming.customDaily', 'daily at {{times}}', { times })
      }
    }
  })()
  return zone ? `${text} (${zone})` : text
}
