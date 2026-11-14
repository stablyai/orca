/** Folded rows retain the first occurrence date; count/latest occurrence must expose continuing failures rather than suggesting one old event. */

import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatAutomationDateTime } from '../automation-page-parts'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type AutomationRunOccurrences = Pick<AutomationRun, 'occurrenceCount' | 'lastOccurrenceAt'>

/** The label's condition without its cost; row-size estimation asks it per history item. */
export function isAutomationRunFolded(run: AutomationRunOccurrences): boolean {
  return (run.occurrenceCount ?? 1) > 1
}

/** Null for the single-occurrence rows, which is every row written before folding. */
export function automationRunOccurrenceLabel(
  run: AutomationRunOccurrences,
  t: Translate = translate,
  intlLocale?: string
): string | null {
  if (!isAutomationRunFolded(run)) {
    return null
  }
  const count = run.occurrenceCount ?? 1
  // Older hosts may supply count without the jointly stamped timestamp; still show the count.
  return run.lastOccurrenceAt
    ? t(
        'auto.components.automations.runHistory.occurrencesWithLatestCount',
        '{{count}} times, most recently {{date}}',
        {
          count,
          date: formatAutomationDateTime(run.lastOccurrenceAt, t, intlLocale),
          defaultValue_one: '{{count}} time, most recently {{date}}'
        }
      )
    : t('auto.components.automations.runHistory.occurrencesCount', '{{count}} times', {
        count,
        defaultValue_one: '{{count}} time'
      })
}
