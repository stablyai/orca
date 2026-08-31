/**
 * Copy for a run row that stands for more than one occurrence.
 *
 * Coalescing replaced a hundred identical refusals with one row, but that row is
 * stamped with the *first* occurrence — so a failure that is still happening
 * every hour reads as one thing that happened once, days ago. The count answers
 * how bad; the latest timestamp answers whether it is over.
 */

import type { AutomationRun } from '../../../../shared/automations-types'
import { formatAutomationDateTime } from './automation-page-parts'
import { translate } from '@/i18n/i18n'

type AutomationRunOccurrences = Pick<AutomationRun, 'occurrenceCount' | 'lastOccurrenceAt'>

/** Null for the single-occurrence rows, which is every row written before folding. */
export function automationRunOccurrenceLabel(run: AutomationRunOccurrences): string | null {
  const count = run.occurrenceCount ?? 1
  if (count <= 1) {
    return null
  }
  // Not named `count`: i18next reserves it for plural selection, which would send
  // these keys looking for `_one`/`_other` variants the catalog does not carry.
  // The label only renders above 1, so the plural is always right.
  const times = String(count)
  // The writer stamps both fields together; a count without a timestamp can only
  // come from an older host, and the count alone still beats saying nothing.
  return run.lastOccurrenceAt
    ? translate(
        'auto.components.automations.runHistory.occurrencesWithLatest',
        '{{times}} times, most recently {{date}}',
        { times, date: formatAutomationDateTime(run.lastOccurrenceAt) }
      )
    : translate('auto.components.automations.runHistory.occurrences', '{{times}} times', { times })
}
