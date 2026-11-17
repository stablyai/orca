import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatMinutesDuration, uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { formatUiAutomationScheduleDescriptor } from '@/components/automations/details/automation-schedule-label'
import {
  formatAutomationScheduleTime,
  type AutomationScheduleDescriptor
} from '../../../../shared/automations/scheduling/automation-schedules'
import { getUiWeekdayNames } from '@/i18n/weekday-names'
import { eventWithPlace } from '@/components/bots/bot-automation-when'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  automationReceiptStarts,
  type AutomationReceiptStart
} from '../../../../shared/automations/automation-receipt-summary'

type Saved = NonNullable<NativeChatMessage['automationSaved']>
const zoneNames = new Map<string, string | null>()
const INSTANT_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

export function receiptZoneName(zone: string): string | null {
  const key = `${getIntlLocale()}\n${zone}`
  if (zoneNames.has(key)) {
    return zoneNames.get(key) ?? null
  }
  let name: string | null = null
  try {
    name =
      uiDateTimeFormat({ timeZone: zone, timeZoneName: 'shortGeneric' })
        .formatToParts(0)
        .find((part) => part.type === 'timeZoneName')?.value ?? zone
  } catch {
    name = null
  }
  if (zoneNames.size >= 32) {
    zoneNames.delete(zoneNames.keys().next().value!)
  }
  zoneNames.set(key, name)
  return name
}

export function receiptInstant(at: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(
      getIntlLocale(),
      timeZone ? { ...INSTANT_FORMAT, timeZone, timeZoneName: 'short' } : INSTANT_FORMAT
    ).format(at)
  } catch {
    return translate('components.native-chat.automationSaved.timeUnknown', 'Time unavailable')
  }
}

function scheduleLabel(schedule: AutomationScheduleDescriptor): string {
  if (schedule.kind === 'custom' || schedule.kind === 'invalid') {
    return formatUiAutomationScheduleDescriptor(schedule)
  }
  if (schedule.kind === 'hourly') {
    return schedule.minute === 0
      ? translate('components.native-chat.automationSaved.everyHour', 'every hour')
      : translate('components.native-chat.automationSaved.hourlyAt', 'every hour at :{{minute}}', {
          minute: String(schedule.minute).padStart(2, '0')
        })
  }
  const time = formatAutomationScheduleTime(schedule.hour, schedule.minute, true)
  if (schedule.kind === 'daily') {
    return translate('components.native-chat.automationSaved.everyDay', 'every day at {{time}}', {
      time
    })
  }
  if (schedule.kind === 'weekdays') {
    return translate(
      'components.native-chat.automationSaved.everyWeekday',
      'every weekday at {{time}}',
      { time }
    )
  }
  return translate(
    'components.native-chat.automationSaved.everyWeek',
    'every {{day}} at {{time}}',
    { day: getUiWeekdayNames()[schedule.dayOfWeek], time }
  )
}

function startLabel(start: AutomationReceiptStart): string {
  if (start.kind === 'unknown') {
    return translate(
      'components.native-chat.automationSaved.triggerNotRecorded',
      'Trigger details weren’t recorded'
    )
  }
  if (start.kind === 'deadline') {
    return receiptInstant(start.at)
  }
  if (start.kind === 'schedule') {
    const schedule = scheduleLabel(start.schedule)
    const zone = start.zone ? receiptZoneName(start.zone) : null
    return zone
      ? `${schedule} ${zone}`
      : translate(
          'components.native-chat.automationSaved.scheduleZoneUnknown',
          '{{schedule}} (time zone not recorded)',
          { schedule }
        )
  }
  const google = start.extra?.google
  if (start.trigger.source === 'calendar') {
    return google?.kind === 'calendar'
      ? google.minutesBefore === 0
        ? translate(
            'components.native-chat.automationSaved.calendarAtStart',
            'When a meeting starts'
          )
        : translate(
            'components.native-chat.automationSaved.calendarBefore',
            '{{duration}} before a meeting',
            { duration: formatMinutesDuration(google.minutesBefore) }
          )
      : translate(
          'components.native-chat.automationSaved.calendarTimingUnknown',
          'On a saved Calendar trigger (timing not recorded)'
        )
  }
  return eventWithPlace(start.trigger)
}

export function automationReceiptSummary(saved: Saved, shortened = false): string {
  if (!saved.automation.enabled) {
    return translate('components.native-chat.automationSaved.pausedWhenSaved', 'Paused when saved')
  }
  return automationReceiptTriggerSummary(saved, shortened)
}

export function automationReceiptTriggerSummary(saved: Saved, shortened = false): string {
  const starts = automationReceiptStarts(saved.automation, saved.receiptFacts, shortened)
  if (starts.length > 2) {
    return translate(
      'components.native-chat.automationSaved.savedSeveralTriggers',
      'Saved: {{count}} start conditions',
      { count: starts.length }
    )
  }
  const labels = starts.map(startLabel)
  const description =
    saved.automation.once && starts.length > 1
      ? translate(
          'components.native-chat.automationSaved.firstOf',
          '{{starts}} — whichever came first',
          {
            starts: labels.join(translate('components.native-chat.automationSaved.or', ', or '))
          }
        )
      : labels.join(translate('components.native-chat.automationSaved.or', ', or '))
  return translate(
    'components.native-chat.automationSaved.savedTrigger',
    'Saved: {{description}}',
    { description }
  )
}
