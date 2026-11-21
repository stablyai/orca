import type { AutomationBotResultsTo } from '../../../../../shared/automations/automation-definition'
import { botResultsPlace } from '../../../../../shared/automation-bot-target'

type PostedResultsTo = Extract<AutomationBotResultsTo, object>

/** The same kind of post, to `place`; the host looks a typed name or link up again on save. */
export function withBotResultsPlace(resultsTo: PostedResultsTo, place: string): PostedResultsTo {
  if (place === botResultsPlace(resultsTo)) {
    return resultsTo
  }
  return 'channel' in resultsTo ? { channel: place } : { linearIssue: place }
}
