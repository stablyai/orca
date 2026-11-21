// Which event sources reach a bot: each one's events arrive only through that connector, set up for that bot.
import {
  AUTOMATION_EVENT_KINDS,
  hasAutomationSchedule,
  type AutomationEventSource,
  isConnectorSource,
  type AutomationEventTrigger,
  type ConnectorEventSource
} from './automation-event-triggers'
import { isGoogleTrigger } from './automation-google-triggers'
import type { Automation } from './automations/automation-definition'
import type { Bot } from './bot-types'
import { CONNECTOR_SOURCE_NAMES } from './connectors/external-conversation-link'
import {
  hostNotSignedIn,
  unknownHostSignInHint,
  withServerSignInSteps
} from './bots/host-orca-sign-in'

// An older host's bots omit the connectors it doesn't have. webhooks: whether the Orca Cloud of the
// bot's host takes webhooks; a webhook needs no account, so the cloud alone decides.
// cloudSignedOut: the bot's host isn't signed in to Orca Cloud (orcaCloudNeedsSignIn), so nothing
// reaches it through Orca Cloud.
export type BotConnectors = Pick<Bot, 'name'> &
  Partial<Pick<Bot, 'slack' | 'github' | 'linear' | 'google'>> & {
    webhooks?: boolean
    cloudSignedOut?: boolean
    /** Its host is a headless Orca server by this name, whose signed-out copy names it; null on a
     *  computer with Orca's window; absent from an older host, which didn't say. */
    signInServer?: string | null
    /** Its host's Orca Cloud sends GitHub's newer events and label= (`triggers.github2`). */
    githubEvents2?: boolean
    /** Its host's Orca Cloud sends github.workflow_finished (`triggers.workflows`). */
    githubWorkflows?: boolean
  }

type EventRule = Pick<AutomationEventTrigger, 'source' | 'event'>

const WEBHOOKS_OFF = "Orca Cloud doesn't support webhooks yet"

/** The sources whose events can start this bot's automations. */
export function botEventSources(bot: BotConnectors): AutomationEventSource[] {
  const connected: Record<AutomationEventSource, unknown> = {
    slack: bot.slack,
    github: bot.github,
    linear: bot.linear,
    webhook: bot.webhooks === true,
    // Google events come from this host's own sign-in, once the owner turns Google on for the bot.
    gmail: bot.google === true,
    calendar: bot.google === true
  }
  return Object.keys(connected)
    .filter(isEventSource)
    .filter((source) => Boolean(connected[source]))
}

function isEventSource(key: string): key is AutomationEventSource {
  return key in AUTOMATION_EVENT_KINDS
}

/** The rules whose connector this bot doesn't have, so they never start it. */
export function unheardEventTriggers<Rule extends EventRule>(
  bot: BotConnectors,
  triggers: readonly Rule[]
): Rule[] {
  const heard = botEventSources(bot)
  return triggers.filter((trigger) => !heard.includes(trigger.source))
}

const googleOff = (bot: BotConnectors) =>
  `Google is off for ${bot.name}; its owner can turn it on with \`orca google bot "${bot.name}" --on\``

// "Slack", "Slack or GitHub", "Slack, GitHub or Linear".
function connectorNames(
  sources: readonly ConnectorEventSource[],
  conjunction: 'or' | 'and'
): string {
  const names = [...new Set(sources.map((source) => CONNECTOR_SOURCE_NAMES[source]))]
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}`
    : (names[0] ?? '')
}

/** The rules whose events come through Orca Cloud: Slack, GitHub, Linear and webhooks. */
export function cloudEventRules<Rule extends EventRule>(triggers: readonly Rule[]): Rule[] {
  return triggers.filter(({ source }) => isConnectorSource(source) || source === 'webhook')
}

// "Slack events", "Slack and GitHub events", "webhooks", "Slack events and webhooks".
function cloudEventNames(rules: readonly EventRule[]): string {
  const connectors = rules.map(({ source }) => source).filter(isConnectorSource)
  const names = [
    ...(connectors.length > 0 ? [`${connectorNames(connectors, 'and')} events`] : []),
    ...(rules.some(({ source }) => source === 'webhook') ? ['webhooks'] : [])
  ]
  return names.join(' and ')
}

function signedOutRefusal(bot: BotConnectors, rules: readonly EventRule[]): string {
  const offer = rules[0].source === 'webhook' ? 'webhook' : rules[0].source
  return withServerSignInSteps(
    [
      `${hostNotSignedIn(bot.signInServer)}, and ${cloudEventNames(rules)} reach ${bot.name} through Orca Cloud, so nothing was saved.`,
      `Run \`orca bot connectors --offer ${offer}\` to show your owner a Sign in line in this chat, then save it again once they say they're signed in.`,
      unknownHostSignInHint(bot.signInServer)
    ]
      .filter(Boolean)
      .join(' '),
    bot.signInServer,
    bot.name,
    'bot'
  )
}

/** `trigger-options`' line for a bot whose host isn't signed in to Orca Cloud. */
export function signedOutTriggerOptionsNote(bot: BotConnectors): string {
  return withServerSignInSteps(
    [
      `${hostNotSignedIn(bot.signInServer)}, and Slack, GitHub, Linear and webhook events reach ${bot.name} through Orca Cloud: before saving one, run \`orca bot connectors --offer <source>\` so your owner sees a Sign in line in this chat, and save it once they say they're signed in.`,
      // An older host doesn't say whether it is a headless server: keep its terminal sign-in in view.
      unknownHostSignInHint(bot.signInServer)
    ]
      .filter(Boolean)
      .join(' '),
    bot.signInServer,
    bot.name,
    'bot'
  )
}

/** Why these rules can't start this bot and what can instead; null when every rule can. */
export function botEventTriggerRefusal(
  bot: BotConnectors,
  triggers: readonly EventRule[]
): string | null {
  // Asked before anything else: signed in, the rest may be fine, and the owner signs in from the chat.
  const cloud = bot.cloudSignedOut ? cloudEventRules(triggers) : []
  if (cloud.length > 0) {
    return signedOutRefusal(bot, cloud)
  }
  const unheard = unheardEventTriggers(bot, triggers)
  if (unheard.some(({ source }) => source === 'webhook')) {
    return `${WEBHOOKS_OFF}, so webhook.call would never start ${bot.name}.`
  }
  if (unheard.length === 0) {
    return null
  }
  const google = unheard.filter(({ source }) => isGoogleTrigger({ source }))
  if (google.length === unheard.length) {
    const events = [...new Set(google.map(({ source, event }) => `${source}.${event}`))]
    return `${googleOff(bot)}. Until then ${events.join(', ')} would never start it.`
  }
  const events = [
    ...new Set(
      unheard
        .filter(({ source }) => isConnectorSource(source))
        .map(({ source, event }) => `${source}.${event}`)
    )
  ]
  const heard = botEventSources(bot).filter(isConnectorSource)
  return [
    `${bot.name} has no ${connectorNames(
      unheard.map(({ source }) => source).filter(isConnectorSource),
      'or'
    )} connector, so ${events.join(', ')} would never start it.`,
    heard.length > 0
      ? `It can start on ${connectorNames(heard, 'and')} events or on a schedule; \`orca automations trigger-options --bot "${bot.name}"\` lists them.`
      : 'It has no connectors, so it can start only on a schedule.',
    "Its owner can add a connector in the bot's settings."
  ].join(' ')
}

/** Why a saved rule never fires, for a listing; null when it can. */
export function wontFireNote(bot: BotConnectors, triggers: readonly EventRule[]): string | null {
  const cloud = bot.cloudSignedOut ? cloudEventRules(triggers) : []
  if (cloud.length > 0) {
    return `won't fire until ${bot.signInServer ?? 'this computer'} signs in to Orca Cloud (${cloud.map(({ source, event }) => `${source}.${event}`).join(', ')})`
  }
  // Only a host that says its cloud stopped taking webhooks; an older one doesn't say.
  const unheard = unheardEventTriggers({ ...bot, webhooks: bot.webhooks ?? true }, triggers)
  const connectors = unheard.filter(({ source }) => isConnectorSource(source))
  const google = unheard.filter(({ source }) => isGoogleTrigger({ source }))
  const reasons = [
    ...(connectors.length > 0
      ? [
          `${bot.name} has no ${connectorNames(
            connectors.map(({ source }) => source).filter(isConnectorSource),
            'or'
          )} connector (${connectors.map(({ source, event }) => `${source}.${event}`).join(', ')})`
        ]
      : []),
    ...(google.length > 0
      ? [
          `Google is off for ${bot.name} (${google.map(({ source, event }) => `${source}.${event}`).join(', ')})`
        ]
      : []),
    ...(unheard.some(({ source }) => source === 'webhook')
      ? [`${WEBHOOKS_OFF} (webhook.call)`]
      : [])
  ]
  return reasons.length > 0 ? `won't fire: ${reasons.join('; ')}` : null
}

/** A bot automation's event sources its bot has no connector for; null when it hears them all or
 *  the bot is not listed (deleted, or another host's). `scheduled`: its schedule still runs it. */
export function automationUnheardSources<B extends BotConnectors & Pick<Bot, 'id'>>(
  automation: Pick<Automation, 'dtstart'> & {
    bot?: { botId: string }
    on?: readonly EventRule[]
  },
  bots: readonly B[]
): { bot: B; sources: AutomationEventSource[]; scheduled: boolean } | null {
  const botId = automation.bot?.botId
  const bot = botId ? bots.find((entry) => entry.id === botId) : undefined
  if (!bot) {
    return null
  }
  // As in wontFireNote: a list that doesn't say whether the cloud takes webhooks lets them fire.
  const heard = { ...bot, webhooks: bot.webhooks ?? true }
  const sources = [
    ...new Set(unheardEventTriggers(heard, automation.on ?? []).map((t) => t.source))
  ]
  return sources.length > 0 ? { bot, sources, scheduled: hasAutomationSchedule(automation) } : null
}
