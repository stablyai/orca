import {
  describeAutomationSchedule,
  formatAutomationScheduleTime,
  type AutomationScheduleDescriptor
} from '../../../../shared/automation-schedules'
import { translate } from '@/i18n/i18n'
import { getUiWeekdayNames } from '@/i18n/weekday-names'

/**
 * Localized schedule label for UI surfaces. The shared formatter stays English because the CLI
 * consumes it; word order and plural form differ per locale, so each sentence is one catalog key
 * rather than a localized weekday concatenated with an English suffix.
 */
export function formatUiAutomationScheduleDescriptor(
  descriptor: AutomationScheduleDescriptor
): string {
  if (descriptor.kind === 'invalid') {
    return translate(
      'auto.components.automations.automation.schedule.label.086a5a9fe2',
      'Invalid schedule'
    )
  }
  if (descriptor.kind === 'custom') {
    return translate(
      'auto.components.automations.automation.schedule.label.ba20c92073',
      'Custom schedule'
    )
  }
  if (descriptor.kind === 'hourly') {
    return translate(
      'auto.components.automations.automation.schedule.label.a95afb7483',
      'Hourly at :{{minute}}',
      { minute: String(descriptor.minute).padStart(2, '0') }
    )
  }
  const time = formatAutomationScheduleTime(descriptor.hour, descriptor.minute)
  if (descriptor.kind === 'daily') {
    return translate(
      'auto.components.automations.automation.schedule.label.280ccd2701',
      'Daily at {{time}}',
      { time }
    )
  }
  if (descriptor.kind === 'weekdays') {
    return translate(
      'auto.components.automations.automation.schedule.label.3f1422adc1',
      'Weekdays at {{time}}',
      { time }
    )
  }
  return translate(
    'auto.components.automations.automation.schedule.label.cc71e252ba',
    '{{day}}s at {{time}}',
    { day: getUiWeekdayNames()[descriptor.dayOfWeek], time }
  )
}

/** Convenience wrapper for callers that hold the raw cron/RRULE expression. */
export function formatUiAutomationSchedule(scheduleExpression: string): string {
  return formatUiAutomationScheduleDescriptor(describeAutomationSchedule(scheduleExpression))
}
