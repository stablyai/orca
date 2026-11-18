// The Connect card a bot asks Orca to put in its chat (`orca bot connectors --offer`). Older clients and
// the phone paint its `text` as a plain line.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'
import { CONNECTOR_SOURCE_NAMES } from '../connectors/external-conversation-link'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../bot-types'
import { googleBotAsk, type GoogleBotConnectState } from '../google/google-bot-connect-state'

export const CONNECTOR_OFFER_SOURCES = ['slack', 'linear', 'github', 'google'] as const
export type ConnectorOfferSource = (typeof CONNECTOR_OFFER_SOURCES)[number]
/** The sources whose card a bot's own links decide; Google's depends on this computer too. */
export type LinkedOfferSource = Exclude<ConnectorOfferSource, 'google'>

export const CONNECTOR_OFFER_NAMES: Record<ConnectorOfferSource, string> = {
  ...CONNECTOR_SOURCE_NAMES,
  google: 'Google'
}

/** What `--offer` takes: the connectors, and webhooks, which are offered only as Sign in. */
export const OFFER_SOURCES = [...CONNECTOR_OFFER_SOURCES, 'webhook'] as const
export type OfferSource = (typeof OFFER_SOURCES)[number]

export const CONNECTOR_OFFER_PRESENTATION = 'connector-offer'

export const ConnectorOfferSchema = z.object({
  botId: z.string().min(1),
  source: z.enum(OFFER_SOURCES),
  /** A workspace or org the owner named that the bot isn't in yet: the card adds it. */
  workspace: z.string().trim().min(1).max(200).optional(),
  /** Already connected: the card adds access (GitHub repositories or organizations, or another
   *  Slack or Linear workspace). */
  addAccess: z.literal(true).optional(),
  /** The host is signed out of Orca: the card is a Sign in line for the source's events. */
  signIn: z.literal(true).optional()
})

export type ConnectorOffer = z.infer<typeof ConnectorOfferSchema>

// What a connected source's add-access card adds: GitHub's install page covers both repositories and orgs.
function addAccessWhat(source: LinkedOfferSource): string {
  return source === 'github'
    ? 'more GitHub repositories or organizations'
    : `another ${CONNECTOR_OFFER_NAMES[source]} workspace`
}

// "Slack events", "Webhooks": what a sign-in card is for.
function signInWhat(source: OfferSource): string {
  return source === 'webhook' ? 'Webhooks' : `${CONNECTOR_OFFER_NAMES[source]} events`
}

/** The line a client that can't draw the card shows instead. */
export function connectorOfferText(offer: ConnectorOffer, botName: string): string {
  if (offer.signIn || offer.source === 'webhook') {
    return `${signInWhat(offer.source)} need Orca sign-in. Sign in to Orca on your computer, then tell ${botName}.`
  }
  const name = CONNECTOR_OFFER_NAMES[offer.source]
  if (offer.addAccess && offer.source !== 'google') {
    return `${botName} asks to add ${addAccessWhat(offer.source)}. Add them from ${name} on ${botName}'s page in Orca on your computer.`
  }
  const what = offer.workspace ? `${name} (${offer.workspace})` : name
  return `${botName} asks to connect ${what}. Connect it from Add connector on ${botName}'s page in Orca on your computer.`
}

export function connectorOfferBody(
  offer: ConnectorOffer,
  botName: string
): AgentJournalPlainStatusItem & { connectorOffer: ConnectorOffer } {
  return {
    kind: 'status',
    text: connectorOfferText(offer, botName),
    presentation: CONNECTOR_OFFER_PRESENTATION,
    connectorOffer: offer
  }
}

/** The offer on a journal item, or null when it carries none or one this build can't read. */
export function connectorOfferOf(body: AgentJournalItemBody): ConnectorOffer | null {
  if (!('connectorOffer' in body)) {
    return null
  }
  const parsed = ConnectorOfferSchema.safeParse(body.connectorOffer)
  return parsed.success ? parsed.data : null
}

type OfferingBot = Pick<Bot, 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'>

function connected(bot: OfferingBot, source: LinkedOfferSource): boolean {
  return source === 'slack'
    ? botSlackApps(bot).length > 0
    : source === 'linear'
      ? botLinearWorkspaces(bot).length > 0
      : bot.github !== null
}

/** Whether a Linear workspace the owner named is one the bot is in; the others' names live in the cloud. */
function inNamedLinearWorkspace(bot: OfferingBot, workspace: string): boolean {
  const wanted = workspace.toLowerCase()
  return botLinearWorkspaces(bot).some(
    (entry) =>
      entry.workspaceName.toLowerCase() === wanted || entry.urlKey?.toLowerCase() === wanted
  )
}

/**
 * A host signed out of Orca offers Sign in for what reaches the bot through Orca Cloud: webhooks, or a
 * connector it already has (one it lacks gets the Connect card, whose setup asks for sign-in first).
 * Null when the offer isn't a sign-in one.
 */
export function signInOfferReply(
  bot: OfferingBot,
  source: OfferSource,
  signedOut: boolean
): { offered: boolean; message: string } | null {
  if (source === 'google' || (source !== 'webhook' && !(signedOut && connected(bot, source)))) {
    return null
  }
  if (!signedOut) {
    return {
      offered: false,
      message:
        'This computer is signed in to Orca, so webhooks need no card; no card was shown. Set up the webhook again.'
    }
  }
  return {
    offered: true,
    message: `Your owner now sees a Sign in line for ${signInWhat(source).toLowerCase()} in this chat. Once they sign in, they'll tell you; then save it again. Don't tell them where to click.`
  }
}

/** What `bot connectors --offer` answers. A source the bot has gets the card that adds access (more GitHub
 *  repositories or organizations, or another workspace), except a Linear workspace it is already in. The
 *  bot eval's stand-in answers with it too. */
export function connectorOfferReply(
  bot: OfferingBot,
  source: LinkedOfferSource,
  workspace: string | undefined
): { offered: boolean; message: string; addAccess?: true } {
  const name = CONNECTOR_OFFER_NAMES[source]
  if (source === 'linear' && workspace && inNamedLinearWorkspace(bot, workspace)) {
    return {
      offered: false,
      message: `${name} is already connected in ${workspace}; no card was shown.`
    }
  }
  // A workspace named for Slack or Linear gets its own Add workspace card; GitHub's page picks the org.
  if (connected(bot, source) && (source === 'github' || !workspace)) {
    return {
      offered: true,
      addAccess: true,
      message: `${name} is already connected. Your owner now sees a card in this chat to add ${addAccessWhat(source)}${workspace ? ` (${workspace})` : ''}; don't ask which. Before using a new one, check with \`orca bot connectors\`.`
    }
  }
  return {
    offered: true,
    message: `Your owner now sees a Connect card for ${name}${workspace ? ` (${workspace})` : ''} in this chat; it turns to Connected once they connect it. Don't tell them where to click. Before using it, check with \`orca bot connectors\`.`
  }
}

/** What `bot connectors --offer google` answers; a card only where the owner can answer it. */
export function googleOfferReply(
  state: GoogleBotConnectState,
  context: { headless: boolean; botName: string }
): { offered: boolean; message: string } {
  const ask = googleBotAsk(state, { ...context, from: 'offer' })
  return { offered: ask.kind === 'card', message: ask.message }
}
