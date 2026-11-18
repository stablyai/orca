import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import {
  automationUnheardSources,
  cloudEventRules,
  type BotConnectors
} from '../../../../../shared/bot-event-sources'
import { CONNECTOR_SOURCE_NAMES } from '../../../../../shared/connectors/external-conversation-link'
import {
  hasAutomationSchedule,
  isConnectorSource
} from '../../../../../shared/automation-event-triggers'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

type ListedBot = BotConnectors & Pick<Bot, 'id'> & { hostId?: ExecutionHostId }

/** "Won't run: needs the Slack connector" when the bot lacks a connector its events come through,
 *  or its host's Orca Cloud doesn't take webhooks. `webhooks` is the host's word; an older host
 *  says nothing, and then its webhooks are taken to fire. `signedOut`: this computer is signed out
 *  of Orca, so its bots hear nothing through Orca Cloud. */
export function automationWontFire<B extends ListedBot>(
  automation: Parameters<typeof automationUnheardSources>[0],
  bots: readonly B[],
  webhooks?: boolean,
  signedOut = false
): { bot: B; label: string; needsConnector: boolean } | null {
  // Signed out, the real reason, not a missing connector or unsupported webhooks.
  const owner = bots.find((entry) => entry.id === automation.bot?.botId)
  if (
    signedOut &&
    owner &&
    (owner.hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
    cloudEventRules(automation.on ?? []).length > 0
  ) {
    const label = hasAutomationSchedule(automation)
      ? translate(
          'bots.cloudSignIn.automationScheduledOnly',
          'Runs on its schedule only: its events are paused while signed out of Orca'
        )
      : translate('bots.cloudSignIn.automationPaused', 'Paused while signed out of Orca')
    return { bot: owner, label, needsConnector: false }
  }
  const unheard = automationUnheardSources(
    automation,
    webhooks === undefined ? bots : bots.map((bot) => ({ ...bot, webhooks }))
  )
  if (!unheard) {
    return null
  }
  const { sources, scheduled } = unheard
  // The caller's own bot, not the copy carrying the host's word.
  const bot = bots.find((entry) => entry.id === unheard.bot.id) ?? unheard.bot
  // Gmail and Calendar both come through the bot's one Google switch.
  const names = [
    ...new Set(
      sources.flatMap((source) =>
        isConnectorSource(source)
          ? [CONNECTOR_SOURCE_NAMES[source]]
          : source === 'webhook'
            ? []
            : ['Google']
      )
    )
  ]
  if (names.length === 0) {
    const label = scheduled
      ? translate(
          'automations.webhooksOffScheduled',
          'Runs on its schedule only: Orca Cloud doesn’t support webhooks yet'
        )
      : translate('automations.webhooksOff', 'Won’t run: Orca Cloud doesn’t support webhooks yet')
    return { bot, label, needsConnector: false }
  }
  const connectors = new Intl.ListFormat(getIntlLocale(), { type: 'disjunction' }).format(names)
  // A schedule still runs it; only its events are lost.
  const label = scheduled
    ? translate(
        'automations.eventsWontFire',
        'Runs on its schedule only: needs the {{connectors}} connector',
        { connectors }
      )
    : translate('automations.wontFire', 'Won’t run: needs the {{connectors}} connector', {
        connectors
      })
  return { bot, label, needsConnector: true }
}
