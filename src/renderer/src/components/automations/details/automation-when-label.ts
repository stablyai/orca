import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { hasAutomationSchedule } from '../../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { formatAutomationNextRun } from '../automation-page-parts'

/** An events-only automation has no next run, only the schedule no Orca reaches. */
export function automationNextRunLabel(
  automation: Automation,
  now: number,
  t: Translate = translate,
  intlLocale?: string
): string {
  return hasAutomationSchedule(automation)
    ? formatAutomationNextRun(automation.nextRunAt, now, t, intlLocale)
    : t('automations.botEvents.nextRun', 'Runs on events')
}
