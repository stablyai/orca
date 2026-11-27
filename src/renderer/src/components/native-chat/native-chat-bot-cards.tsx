import { NativeChatMemoryUpdatedRow } from './NativeChatMemoryUpdatedRow'
// The cards a bot's chat draws in place of a status line: offers, import plans, setup cards, requests.
import type { NativeChatTextBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  nativeChatBotCardOf,
  type NativeChatBlockBotCardKind,
  type NativeChatBotCardValues,
  type NativeChatMessageBotCard
} from '../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { ComposioSetupChatCard } from '../bots/composio/ComposioSetupChatCard'
import { GoogleSetupChatCard } from '../bots/google/setup-cards/GoogleSetupChatCard'
import { NativeChatBotCreateOfferCard } from './NativeChatBotCreateOfferCard'
import { NativeChatBotRequestCard } from './NativeChatBotRequestCard'
import { NativeChatConnectorOfferCard } from './NativeChatConnectorOfferCard'
import { NativeChatImportDoneCard } from './NativeChatImportDoneCard'
import { NativeChatImportPlanCard } from './NativeChatImportPlanCard'
import { NativeChatToolAddedCard } from './NativeChatToolAddedCard'

type CardContext = {
  messageId: string
  timestamp: number | null
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}

const DESKTOP_BOT_CARDS: {
  [K in NativeChatBlockBotCardKind]: (
    card: NativeChatBotCardValues[K],
    context: CardContext
  ) => React.JSX.Element
} = {
  memoryUpdated: (note) => <NativeChatMemoryUpdatedRow note={note} />,
  connectorOffer: (offer, { messageId, fallback }) => (
    <NativeChatConnectorOfferCard offer={offer} messageId={messageId} fallback={fallback} />
  ),
  importPlan: (plan, { messageId }) => (
    <NativeChatImportPlanCard plan={plan} messageId={messageId} />
  ),
  importDone: (done) => <NativeChatImportDoneCard done={done} />,
  botRequest: (card, { messageId, timestamp, fallback }) => (
    <NativeChatBotRequestCard
      card={card}
      cardId={messageId}
      timestamp={timestamp}
      fallback={fallback}
    />
  ),
  googleSetup: (card, { fallback }) => <GoogleSetupChatCard card={card} fallback={fallback} />,
  composioSetup: (card, { fallback }) => <ComposioSetupChatCard card={card} fallback={fallback} />,
  createOffer: (offer, { messageId, fallback }) => (
    <NativeChatBotCreateOfferCard offer={offer} messageId={messageId} fallback={fallback} />
  )
}

function drawCard<K extends NativeChatBlockBotCardKind>(
  card: { kind: K; value: NativeChatBotCardValues[K] },
  context: CardContext
): React.JSX.Element {
  const draw: (value: NativeChatBotCardValues[K], context: CardContext) => React.JSX.Element =
    DESKTOP_BOT_CARDS[card.kind]
  return draw(card.value, context)
}

/** The card for a status line that carries one, or null. */
export function nativeChatBotCard(
  block: NativeChatTextBlock,
  messageId: string,
  timestamp: number | null = null
): React.JSX.Element | null {
  const card = nativeChatBotCardOf(block)
  return card ? drawCard(card, { messageId, timestamp, fallback: block.text }) : null
}

/** The card a whole message is drawn as. */
export function nativeChatMessageBotCard(
  card: NativeChatMessageBotCard,
  timestamp: number | null
): React.JSX.Element {
  switch (card.kind) {
    case 'toolAdded':
      return <NativeChatToolAddedCard added={card.value} timestamp={timestamp} />
  }
}
