import { translate } from '@/i18n/i18n'
import type { BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import { CONNECTOR_SOURCE_NAMES } from '../../../../shared/connectors/external-conversation-link'

/** What an Activity row is called: a worker's task, a run's automation or a thread's title. */
export function botActivityRowTitle(row: BotSessionActivityRow): string {
  switch (row.kind) {
    case 'worker':
      return row.title || translate('bots.activity.worker', 'Worker')
    case 'run':
      return row.automationName
    case 'thread':
      return (
        row.title ||
        translate('bots.activity.thread', '{{source}} thread', {
          source: CONNECTOR_SOURCE_NAMES[row.source]
        })
      )
  }
}
