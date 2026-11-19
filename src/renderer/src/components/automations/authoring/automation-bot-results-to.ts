import type { AutomationBotResultsTo } from '../../../../../shared/automations/automation-definition'

type PostedResultsTo = Extract<AutomationBotResultsTo, object>

/** The channel or Linear issue a result posts to, by its label where the host saved it as a ref. */
export function botResultsPlace(resultsTo: PostedResultsTo): string {
  return resultsTo.label ?? ('channel' in resultsTo ? resultsTo.channel : resultsTo.linearIssue)
}

/** The same kind of post, to `place`; the host looks a typed name or link up again on save. */
export function withBotResultsPlace(resultsTo: PostedResultsTo, place: string): PostedResultsTo {
  if (place === botResultsPlace(resultsTo)) {
    return resultsTo
  }
  return 'channel' in resultsTo ? { channel: place } : { linearIssue: place }
}
