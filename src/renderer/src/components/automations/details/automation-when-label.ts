import { translate } from '@/i18n/i18n'
import { hasAutomationSchedule } from '../../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { formatAutomationNextRun } from '../automation-page-parts'

/** An events-only automation has no next run, only the schedule no Orca reaches. */
export function automationNextRunLabel(automation: Automation, now: number): string {
  return hasAutomationSchedule(automation)
    ? formatAutomationNextRun(automation.nextRunAt, now)
    : translate('automations.botEvents.nextRun', 'Runs on events')
}
