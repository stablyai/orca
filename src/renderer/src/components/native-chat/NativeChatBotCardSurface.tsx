import { ComposioSetupChatCard } from '../bots/composio/ComposioSetupChatCard'
import { GoogleSetupChatCard } from '../bots/google/setup-cards/GoogleSetupChatCard'
import type {
  NativeChatBlockBotCardKind,
  NativeChatBotCardValues,
  NativeChatMessageBotCard
} from '../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { NativeChatBotCreateOfferCard } from './NativeChatBotCreateOfferCard'
import { NativeChatBotRequestCard } from './NativeChatBotRequestCard'
import { NativeChatConnectorOfferCard } from './NativeChatConnectorOfferCard'
import { NativeChatImportDoneCard } from './NativeChatImportDoneCard'
import { NativeChatImportPlanCard } from './NativeChatImportPlanCard'
import { NativeChatMemoryUpdatedRow } from './NativeChatMemoryUpdatedRow'
import { NativeChatToolAddedCard } from './NativeChatToolAddedCard'

export type NativeChatBotCardContext = {
  messageId: string
  timestamp: number | null
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}

export type NativeChatBlockBotCard = {
  [K in NativeChatBlockBotCardKind]: { kind: K; value: NativeChatBotCardValues[K] }
}[NativeChatBlockBotCardKind]

const DESKTOP_BOT_CARDS: {
  [K in NativeChatBlockBotCardKind]: (
    card: NativeChatBotCardValues[K],
    context: NativeChatBotCardContext
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
  context: NativeChatBotCardContext
): React.JSX.Element {
  const draw: (
    value: NativeChatBotCardValues[K],
    context: NativeChatBotCardContext
  ) => React.JSX.Element = DESKTOP_BOT_CARDS[card.kind]
  return draw(card.value, context)
}

export function NativeChatBotBlockCardSurface({
  card,
  context
}: {
  card: NativeChatBlockBotCard
  context: NativeChatBotCardContext
}): React.JSX.Element {
  return drawCard(card, context)
}

export function NativeChatMessageBotCardSurface({
  card,
  timestamp
}: {
  card: NativeChatMessageBotCard
  timestamp: number | null
}): React.JSX.Element {
  switch (card.kind) {
    case 'toolAdded':
      return <NativeChatToolAddedCard added={card.value} timestamp={timestamp} />
  }
}
