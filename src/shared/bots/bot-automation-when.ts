import { hasAutomationSchedule, type AutomationEventTrigger } from '../automation-event-triggers'
import {
  describeAutomationSchedule,
  type AutomationScheduleDescriptor
} from '../automations/scheduling/automation-schedules'
import type { Automation } from '../automations/automation-definition'

export type BotAutomationWhenPart<T = AutomationEventTrigger> =
  | { kind: 'schedule'; schedule: AutomationScheduleDescriptor }
  | { kind: 'event'; trigger: T }

/** When an automation runs: its schedule, then each event that starts it. Each side words the parts. */
export function botAutomationWhenParts<T>(
  automation: Pick<Automation, 'dtstart' | 'rrule'> & { on?: readonly T[] }
): BotAutomationWhenPart<T>[] {
  return [
    ...(hasAutomationSchedule(automation)
      ? [{ kind: 'schedule' as const, schedule: describeAutomationSchedule(automation.rrule) }]
      : []),
    ...(automation.on ?? []).map((trigger) => ({ kind: 'event' as const, trigger }))
  ]
}
