// Recent calls in words: the cloud's verdict, then the run's outcome in the run history's own labels.
import { translate } from '@/i18n/i18n'
import { botResultsPlace } from '../../automations/authoring/automation-bot-results-to'
import type { AutomationBotResultsTo } from '../../../../../shared/automations/automation-definition'
import type { WebhookCallRow } from '../../../../../shared/rpc-contract/webhooks-params'

/** "run #12 in Chat": the run a call started, and where its results go. */
function runLine(runNumber: number | undefined, resultsTo: AutomationBotResultsTo): string | null {
  if (runNumber === undefined) {
    return null
  }
  // A webhook's run has no thread; a call reads as one with no place.
  if (resultsTo === 'none' || resultsTo === 'thread') {
    return translate('bots.webhooks.calls.run', 'run #{{number}}', { number: runNumber })
  }
  const place =
    resultsTo === 'chat'
      ? translate('bots.webhooks.calls.chat', 'Chat')
      : botResultsPlace(resultsTo)
  return translate('bots.webhooks.calls.runIn', 'run #{{number}} in {{place}}', {
    number: runNumber,
    place
  })
}

/** One Recent calls line: what happened, then why. The cloud's verdict and the run's outcome stay apart. */
export function webhookCallLine(
  row: WebhookCallRow,
  botName: string,
  resultsTo: AutomationBotResultsTo
): { label: string; detail: string } {
  if (row.kind !== 'call') {
    const count = { count: row.count }
    switch (row.kind) {
      case 'refused':
        return {
          label: translate('bots.webhooks.calls.refused', 'Refused ×{{count}}', count),
          detail: translate(
            'bots.webhooks.calls.refusedDetail',
            'wrong key or signature · nothing kept'
          )
        }
      case 'over_budget':
        return {
          label: translate('bots.webhooks.calls.overBudget', 'Over budget ×{{count}}', count),
          detail: translate('bots.webhooks.calls.overBudgetDetail', 'too many calls · nothing kept')
        }
      case 'duplicate':
        return {
          label: translate('bots.webhooks.calls.duplicate', 'Duplicate ×{{count}}', count),
          detail: translate('bots.webhooks.calls.duplicateDetail', 'already received')
        }
    }
  }
  const sample = row.sample ? translate('bots.webhooks.calls.sample', 'sample') : null
  const join = (...parts: (string | null | undefined)[]): string =>
    parts.filter((part): part is string => Boolean(part)).join(' · ')
  const bot = { bot: botName }
  switch (row.state) {
    case 'queued':
      return {
        label: translate('bots.webhooks.calls.queued', 'Queued'),
        detail: join(
          translate('bots.webhooks.calls.queuedDetail', 'waiting for {{bot}}’s computer', bot),
          sample
        )
      }
    case 'delivered':
      return {
        label: translate('bots.webhooks.calls.delivered', 'Delivered'),
        detail: join(
          translate('bots.webhooks.calls.deliveredDetail', 'on {{bot}}’s computer', bot),
          sample
        )
      }
    case 'ignored':
      return {
        label: translate('bots.webhooks.calls.ignored', 'Ignored'),
        detail: join(
          translate('bots.webhooks.calls.ignoredDetail', 'didn’t match Only when'),
          sample
        )
      }
    case 'paused':
      return {
        label: translate('bots.webhooks.calls.paused', 'Paused'),
        detail: join(translate('bots.webhooks.calls.pausedDetail', 'nothing started'), sample)
      }
    case 'cancelled':
      return {
        label: translate('bots.webhooks.calls.cancelled', 'Cancelled'),
        detail: join(
          translate('bots.webhooks.calls.cancelledDetail', 'paused, rotated or deleted first'),
          sample
        )
      }
    case 'waiting_capacity':
      return {
        label: translate('bots.webhooks.calls.waiting', 'Waiting'),
        detail: join(
          translate('bots.webhooks.calls.waitingDetail', 'for the hourly run limit'),
          sample
        )
      }
    case 'started':
      return {
        label: translate('bots.webhooks.calls.started', 'Started'),
        detail: join(runLine(row.runNumber, resultsTo), sample)
      }
    case 'folded':
      return {
        label: translate('bots.webhooks.calls.folded', 'Folded'),
        detail: join(
          translate('bots.webhooks.calls.foldedDetail', 'counted, not shown to the run'),
          sample
        )
      }
    case 'refused':
      return {
        label: translate('bots.webhooks.calls.refusedOne', 'Refused'),
        detail: join(row.reason, sample)
      }
    case 'missed':
      return {
        label: translate('bots.webhooks.calls.missed', 'Skipped'),
        detail: join(
          translate('bots.webhooks.calls.missedDetail', 'past the automation’s missed-run grace'),
          sample
        )
      }
    case 'unavailable':
      return {
        label: translate('bots.webhooks.calls.unavailable', 'Unavailable'),
        detail: join(row.reason, sample)
      }
    case 'completed':
      return { label: translate('bots.webhooks.calls.completed', 'Done'), detail: join(sample) }
    case 'failed':
      return {
        label: translate('bots.webhooks.calls.failed', 'Failed'),
        detail: join(row.reason, sample)
      }
    case 'unverifiable':
      return {
        label: translate('bots.webhooks.calls.unverifiable', 'Unverifiable'),
        detail: join(
          translate(
            'bots.webhooks.calls.unverifiableDetail',
            '{{bot}}’s computer can’t be reached',
            bot
          ),
          sample
        )
      }
  }
}
