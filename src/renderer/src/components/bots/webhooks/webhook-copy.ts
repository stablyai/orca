// Every word the card and the Webhooks row show about a hook. Host outcomes use the run history's own labels.
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { botResultsPlace } from '../../../../../shared/automation-bot-target'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { WebhookAdapterId } from '../../../../../shared/connector-webhook-contract'
import type { AutomationBotResultsTo } from '../../../../../shared/automations/automation-definition'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import type { WebhookErrorCode } from './webhook-host-client'
import { readOrcaCloudSignedOut } from '../orca-cloud-signed-out'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  webhookAdapterGeneratesSecret,
  webhookAdapterName,
  webhookHostReady,
  webhookStatusFact,
  type WebhookStatusFact
} from '../../../../../shared/bots/webhook-card-view'

/** "results to Chat": where the automation sends its results, never assumed. */
export function webhookResultsTo(resultsTo: AutomationBotResultsTo): string {
  if (resultsTo === 'chat') {
    return translate('bots.webhooks.resultsToChat', 'results to Chat')
  }
  if (resultsTo === 'thread') {
    return translate('bots.webhooks.resultsToThread', "results to the event's thread")
  }
  if (resultsTo === 'none') {
    return translate('bots.webhooks.resultsNowhere', 'results not sent')
  }
  return translate('bots.webhooks.resultsToPlace', 'results to {{place}}', {
    place: botResultsPlace(resultsTo)
  })
}

/** “Investigate Sentry alert” · results to Chat */
export function webhookStarts(summary: WebhookSummary): string {
  return `“${summary.automationName}” · ${webhookResultsTo(summary.resultsTo)}`
}

function ago(at: number, now: number): string {
  return formatUiRelativeTime(at - now)
}

/** A hook's state alone, for a row whose caption already says when it was last called. */
export function webhookStateStatus(summary: WebhookSummary): {
  label: string
  tone: IntegrationCardStatusTone
} {
  if (summary.state === 'live') {
    return summary.lastCall
      ? { label: translate('bots.webhooks.status.on', 'On'), tone: 'connected' }
      : { label: translate('bots.webhooks.status.noCalls', 'No calls yet'), tone: 'neutral' }
  }
  return webhookStatus(summary, 0)
}

/** A hook's status beside its name on the card: its state, or when it was last called. */
export function webhookStatus(
  summary: WebhookSummary,
  now: number
): { label: string; tone: IntegrationCardStatusTone } {
  const fact = webhookStatusFact(summary)
  return { label: webhookStatusLabel(fact, now), tone: fact.tone }
}

function webhookStatusLabel(fact: WebhookStatusFact, now: number): string {
  switch (fact.kind) {
    case 'paused':
      return translate('bots.webhooks.status.paused', 'Paused')
    case 'orphaned':
      return translate('bots.webhooks.status.orphaned', 'Not connected')
    case 'pending':
      return translate('bots.webhooks.status.pending', 'Setting up')
    case 'noCalls':
      return translate('bots.webhooks.status.noCalls', 'No calls yet')
    case 'lastCall': {
      const lastCall = translate('bots.webhooks.status.lastCall', 'Last call {{ago}}', {
        ago: ago(fact.at, now)
      })
      // Said only when the cloud's verifier checked this call's signature.
      return fact.signedBy
        ? `${lastCall} · ${translate('bots.webhooks.status.signatureValid', '{{sender}} signature valid', { sender: webhookAdapterName(fact.signedBy) })}`
        : lastCall
    }
  }
}

/** The plain line for a host that can't act on its hooks now, in the wording other connectors use. */
export function webhookHostLine(
  host: WebhookSummary['host'] | WebhookErrorCode,
  botName: string
): string | null {
  if (host === 'offline' || host === 'host_offline') {
    return translate('bots.webhooks.hostOffline', '{{bot}}’s computer is offline', {
      bot: botName
    })
  }
  if (host === 'host_needs_update') {
    return translate(
      'bots.webhooks.hostNeedsUpdate',
      'Your Orca needs an update before {{bot}} can do this.',
      { bot: botName }
    )
  }
  return null
}

/** A bot name for copy that has none: the hook's bot isn't on this computer's list. */
export function webhookUnknownBotName(): string {
  return translate('bots.webhooks.theBot', 'the bot')
}

/**
 * Whether the host can act on the hook now, and the plain line saying why not. A failed refresh
 * keeps the last answer on screen with its reason, and holds back actions until the host answers.
 */
export function webhookHostState(
  summary: WebhookSummary,
  refreshError: WebhookErrorCode | null,
  botName: string,
  target: RuntimeClientTarget
): { ready: boolean; line: string | null } {
  if (refreshError) {
    return {
      ready: false,
      line:
        webhookHostLine(refreshError, botName) ?? webhookErrorMessage(refreshError, botName, target)
    }
  }
  return { ready: webhookHostReady(summary, false), line: webhookHostLine(summary.host, botName) }
}

/** The card's place in a chat where it can't render: where the URL is, never the URL. */
export function webhookFallbackText(
  names: { automationName: string; botName: string } | null
): string {
  return names
    ? translate(
        'bots.webhooks.fallbackNamed',
        'Webhook “{{automation}}” is live. Copy its URL from Orca on a computer: Settings › Bots › {{bot}} › Webhooks. To pause or delete it, ask {{bot}} here.',
        { automation: names.automationName, bot: names.botName }
      )
    : translate(
        'bots.webhooks.fallback',
        'This webhook is live. Copy its URL from Orca on a computer, in the bot’s settings under Webhooks. To pause or delete it, ask the bot here.'
      )
}

/** What a failed read or action says, for the codes that aren't a host state. `target`: the hook's
 *  host, whose own sign-in decides whether it is signed out. */
export function webhookErrorMessage(
  code: WebhookErrorCode,
  botName: string,
  target: RuntimeClientTarget
): string {
  switch (code) {
    case 'webhook_not_found':
      return translate('bots.webhooks.errors.notFound', 'This webhook was deleted.')
    case 'webhooks_unavailable':
      // Signed out, the cloud that takes the calls can't be reached; that is the reason, not support.
      return readOrcaCloudSignedOut(getRuntimeTargetHostId(target))
        ? translate('bots.webhooks.errors.signedOut', 'Paused while signed out of Orca.')
        : translate('bots.webhooks.errors.unavailable', 'Webhooks aren’t available right now.')
    case 'host_offline':
    case 'host_needs_update':
      return webhookHostLine(code, botName) ?? ''
    case 'failed':
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** "Checks": what a call must carry to be accepted. */
export function webhookChecks(adapter: WebhookAdapterId | null): string {
  if (!adapter) {
    return translate('bots.webhooks.checks.key', 'The key in the URL or header')
  }
  return webhookAdapterGeneratesSecret(adapter)
    ? translate('bots.webhooks.checks.generated', '{{sender}} signature, with its signing secret', {
        sender: webhookAdapterName(adapter)
      })
    : translate(
        'bots.webhooks.checks.pasted',
        '{{sender}} signature, with your {{sender}} secret',
        {
          sender: webhookAdapterName(adapter)
        }
      )
}
