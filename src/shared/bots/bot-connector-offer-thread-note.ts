// A Connect card shows only in the bot's Orca chat. When that chat answers a Slack, Linear or GitHub
// thread, the offer's answer tells the bot so, and how its owner gets from the thread to the card.
import {
  conversationPlaceText,
  type ExternalConversationLink
} from '../connectors/external-conversation-link'
import { CONNECTOR_OFFER_NAMES, addAccessWhat, type ConnectorOffer } from './bot-connector-offer'

type ThreadLink = Pick<ExternalConversationLink, 'source' | 'bot' | 'place'>

/** What the card does beyond the offer itself: Google's Connected card adds another account. */
export type ConnectorOfferCardKind = { googleAnotherAccount?: boolean }

/**
 * The line the bot ends a Slack answer with. Orca Cloud puts its "Open this thread in Orca" link under
 * a Slack answer that asks, in English and on one line, to open, answer or check something in Orca,
 * so this line always starts "Open Orca to" (pinned against the cloud's pattern in the tests).
 */
export function connectorOfferOpenLine(
  offer: ConnectorOffer,
  kind: ConnectorOfferCardKind = {}
): string {
  if (offer.signIn || offer.source === 'webhook') {
    return 'Open Orca to sign in to Orca Cloud.'
  }
  if (offer.source === 'google' && kind.googleAnotherAccount) {
    return 'Open Orca to add another Google account.'
  }
  if (offer.addAccess && offer.source !== 'google') {
    return `Open Orca to add ${addAccessWhat(offer.source)}.`
  }
  return `Open Orca to connect ${CONNECTOR_OFFER_NAMES[offer.source]}.`
}

/**
 * What the offer's answer adds when the turn answers a conversation outside Orca (`link`, given only
 * then): that the card isn't there, and how the owner reaches it. Slack's link comes from the line
 * (as plain text: the cloud adds it to no table), Linear's from its agent session; GitHub has none.
 * Null for another bot's link.
 */
export function connectorOfferThreadNote(
  botId: string,
  link: ThreadLink | null | undefined,
  offer: ConnectorOffer,
  kind: ConnectorOfferCardKind = {}
): string | null {
  if (!link || link.bot?.botId !== botId) {
    return null
  }
  const shown = `The card shows only in Orca, not in ${conversationPlaceText(link)}, so don't say it is there. Your final message goes there.`
  if (link.source === 'slack') {
    return `${shown} End it with this line, word for word and in English even if the rest is in another language, and put no table in that message: "${connectorOfferOpenLine(offer, kind)}" Orca then adds a link to this chat under it, so don't write one yourself.`
  }
  const linear =
    link.source === 'linear'
      ? " Linear's agent session on the issue shows Open in Orca, which opens this chat."
      : ''
  return `${shown} Say in it that the card is waiting in Orca.${linear}`
}
