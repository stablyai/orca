// Which webhook card a chat shows: the card only in the hook's own bot's chats; elsewhere the line
// that says where the URL is. Each platform draws it and passes its translations.
import type { WebhookAdapterId } from '../connector-webhook-contract'
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'
import type { WebhookSummary } from '../rpc-contract/webhooks-params'

export const WEBHOOK_CARD_COPY = {
  title: 'Webhook',
  starts: 'Webhook · starts “{{automation}}”',
  sampleNote: 'A sample starts a real run.',
  sendSample: 'Send a sample call',
  secretAdd: 'Add signing secret…',
  secretChange: 'Signing secret: {{sender}} · Change…'
} as const

export type WebhookCardSay = BotCardSay<keyof typeof WEBHOOK_CARD_COPY>

export type WebhookCardShows = 'loading' | 'failed' | 'elsewhere' | 'card'

export function webhookCardShows(
  read: 'loading' | 'failed' | 'ready',
  /** The bot whose chat this is, when it is a bot's. */
  chatBotId: string | null,
  /** The bot the hook starts, once read. */
  hookBotId: string | null
): WebhookCardShows {
  if (read !== 'ready') {
    return read
  }
  return chatBotId !== null && chatBotId === hookBotId ? 'card' : 'elsewhere'
}

/** A sender's own name, never translated. */
export function webhookAdapterName(adapter: WebhookAdapterId): string {
  switch (adapter) {
    case 'standard':
      return 'Standard Webhooks'
    case 'github':
      return 'GitHub'
    case 'sentry':
      return 'Sentry'
    case 'linear':
      return 'Linear'
    case 'pagerduty':
      return 'PagerDuty'
    case 'stripe':
      return 'Stripe'
  }
}

/** Orca can make these secrets; for the others the owner pastes the sender's own. */
export function webhookAdapterGeneratesSecret(adapter: WebhookAdapterId): boolean {
  return adapter === 'standard' || adapter === 'github'
}

/** Every sender but GitHub can take a pasted secret; Standard Webhooks senders may make their own. */
export function webhookAdapterTakesPastedSecret(adapter: WebhookAdapterId): boolean {
  return adapter !== 'github'
}

/** What a hook's status says: its state, or when it was last called. Each platform words it. */
export type WebhookStatusFact =
  | { kind: 'paused' | 'orphaned' | 'pending' | 'noCalls'; tone: 'neutral' }
  /** `signedBy`: the sender whose signature the cloud checked on that call. */
  | { kind: 'lastCall'; at: number; signedBy: WebhookAdapterId | null; tone: 'connected' }

export function webhookStatusFact(summary: {
  state: WebhookSummary['state']
  adapter: WebhookAdapterId | null
  lastCall: { at: number; signatureValid: boolean } | null
}): WebhookStatusFact {
  if (summary.state !== 'live') {
    return { kind: summary.state, tone: 'neutral' }
  }
  const last = summary.lastCall
  if (!last) {
    return { kind: 'noCalls', tone: 'neutral' }
  }
  return {
    kind: 'lastCall',
    at: last.at,
    signedBy: summary.adapter && last.signatureValid ? summary.adapter : null,
    tone: 'connected'
  }
}

/** Whether the host can act on the hook now. A failed refresh keeps the last answer on screen and
 *  holds back actions until the host answers. */
export function webhookHostReady(summary: WebhookSummary, refreshFailed: boolean): boolean {
  return !refreshFailed && summary.host === 'online'
}

export type WebhookCardBodyView = {
  title: string
  status: WebhookStatusFact
  hostReady: boolean
  sampleNote: string
  /** Add or change the signing secret. */
  secret: { label: string; enabled: boolean }
  /** Send a sample call: only to a live hook, while nothing else is running. */
  sample: { label: string; enabled: boolean }
}

export function webhookCardBodyView(
  summary: WebhookSummary,
  local: { refreshFailed: boolean; busy: boolean },
  say: WebhookCardSay
): WebhookCardBodyView {
  const hostReady = webhookHostReady(summary, local.refreshFailed)
  return {
    title: say('starts', { automation: summary.automationName }),
    status: webhookStatusFact(summary),
    hostReady,
    sampleNote: say('sampleNote'),
    secret: {
      label: summary.adapter
        ? say('secretChange', { sender: webhookAdapterName(summary.adapter) })
        : say('secretAdd'),
      enabled: hostReady
    },
    sample: {
      label: say('sendSample'),
      enabled: hostReady && !local.busy && summary.state === 'live'
    }
  }
}
