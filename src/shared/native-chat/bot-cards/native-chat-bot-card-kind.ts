// The one table of bot chat cards. Status-line fields, message fields and chat directives each map
// to a kind here, and every kind records whether the phone draws it or shows the host's line, so a
// new card can't reach one platform silently.
import { parseNativeChatWebhookDirectiveLine } from '../visuals/native-chat-visual-directive'
import type {
  NativeChatBotCardFieldValues,
  NativeChatBotCardFields,
  NativeChatBotMessageCardFieldValues,
  NativeChatBotMessageCardFields
} from './native-chat-bot-card-fields'

type CardField = keyof NativeChatBotCardFieldValues
type MessageCardField = keyof NativeChatBotMessageCardFieldValues

/** Each status-line card field's reader and kind, in reading order. */
const STATUS_LINE_CARDS = {
  botMemoryUpdated: (block: NativeChatBotCardFields) =>
    block.botMemoryUpdated
      ? ({ kind: 'memoryUpdated', value: block.botMemoryUpdated } as const)
      : null,
  connectorOffer: (block: NativeChatBotCardFields) =>
    block.connectorOffer
      ? ({ kind: 'connectorOffer', value: block.connectorOffer } as const)
      : null,
  botImportPlan: (block: NativeChatBotCardFields) =>
    block.botImportPlan ? ({ kind: 'importPlan', value: block.botImportPlan } as const) : null,
  botImportDone: (block: NativeChatBotCardFields) =>
    block.botImportDone ? ({ kind: 'importDone', value: block.botImportDone } as const) : null,
  botRequest: (block: NativeChatBotCardFields) =>
    block.botRequest ? ({ kind: 'botRequest', value: block.botRequest } as const) : null,
  googleSetup: (block: NativeChatBotCardFields) =>
    block.googleSetup ? ({ kind: 'googleSetup', value: block.googleSetup } as const) : null,
  composioSetup: (block: NativeChatBotCardFields) =>
    block.composioSetup ? ({ kind: 'composioSetup', value: block.composioSetup } as const) : null,
  botCreateOffer: (block: NativeChatBotCardFields) =>
    block.botCreateOffer ? ({ kind: 'createOffer', value: block.botCreateOffer } as const) : null
} satisfies {
  [F in CardField]: (block: NativeChatBotCardFields) => {
    kind: string
    value: NativeChatBotCardFieldValues[F]
  } | null
}

/** Each message card field's reader and kind. */
const MESSAGE_CARDS = {
  toolAdded: (message: NativeChatBotMessageCardFields) =>
    message.toolAdded ? ({ kind: 'toolAdded', value: message.toolAdded } as const) : null
} satisfies {
  [F in MessageCardField]: (message: NativeChatBotMessageCardFields) => {
    kind: string
    value: NativeChatBotMessageCardFieldValues[F]
  } | null
}

/** Each card a whole line of an agent's reply names, by the directive that names it. */
const DIRECTIVE_CARDS = {
  webhook: (line: string) => {
    const value = parseNativeChatWebhookDirectiveLine(line)
    return value ? ({ kind: 'webhook', value } as const) : null
  }
} satisfies Record<string, (line: string) => { kind: string; value: object } | null>

type CardOf<Readers extends Record<string, (input: never) => object | null>> = NonNullable<
  ReturnType<Readers[keyof Readers]>
>

/** A card a status line carries. */
export type NativeChatBlockBotCard = CardOf<typeof STATUS_LINE_CARDS>
export type NativeChatBlockBotCardKind = NativeChatBlockBotCard['kind']
/** A card a whole message is drawn as. */
export type NativeChatMessageBotCard = CardOf<typeof MESSAGE_CARDS>
/** A card a line of an agent's reply names. */
export type NativeChatDirectiveBotCard = CardOf<typeof DIRECTIVE_CARDS>

type AnyBotCard = NativeChatBlockBotCard | NativeChatMessageBotCard | NativeChatDirectiveBotCard

/** Every bot card kind, from the three tables above. */
export type NativeChatBotCardKind = AnyBotCard['kind']

export type NativeChatBotCardValues = { [C in AnyBotCard as C['kind']]: C['value'] }

function firstCard<Input, Card>(
  readers: Record<string, (input: Input) => Card | null>,
  input: Input
): Card | null {
  for (const read of Object.values(readers)) {
    const card = read(input)
    if (card) {
      return card
    }
  }
  return null
}

/** Every card a status line carries, in reading order. Each client picks the kinds it draws. */
export function nativeChatBotCardsOf(block: NativeChatBotCardFields): NativeChatBlockBotCard[] {
  const cards: NativeChatBlockBotCard[] = []
  for (const read of Object.values(STATUS_LINE_CARDS)) {
    const card = read(block)
    if (card) {
      cards.push(card)
    }
  }
  return cards
}

/** The first card a status line carries, in reading order; the one the desktop draws. */
export function nativeChatBotCardOf(block: NativeChatBotCardFields): NativeChatBlockBotCard | null {
  return nativeChatBotCardsOf(block)[0] ?? null
}

/** The card a whole message is drawn as, or null. The only reader of the message card fields. */
export function nativeChatBotMessageCardOf(
  message: NativeChatBotMessageCardFields
): NativeChatMessageBotCard | null {
  return firstCard<NativeChatBotMessageCardFields, NativeChatMessageBotCard>(MESSAGE_CARDS, message)
}

/** The card a whole reply line names, or null. */
export function nativeChatBotDirectiveCardOf(line: string): NativeChatDirectiveBotCard | null {
  return firstCard<string, NativeChatDirectiveBotCard>(DIRECTIVE_CARDS, line)
}

/** How the phone shows each kind. `phoneFallback` kinds show the host's line until their PR lands. */
export const NATIVE_CHAT_BOT_CARD_ON_PHONE = {
  memoryUpdated: 'phoneCard',
  connectorOffer: 'phoneCard',
  importPlan: 'phoneCard',
  importDone: 'phoneCard',
  botRequest: 'phoneCard',
  googleSetup: 'phoneCard',
  composioSetup: 'phoneCard',
  createOffer: 'phoneCard',
  toolAdded: 'phoneCard',
  webhook: 'phoneCard'
} as const satisfies Record<NativeChatBotCardKind, 'phoneCard' | 'phoneFallback'>

type OnPhone = typeof NATIVE_CHAT_BOT_CARD_ON_PHONE

/** The phone's renderer map: a `phoneCard` kind without a renderer fails the typecheck. */
export type NativeChatPhoneBotCardRenderers<Render, Context> = {
  [K in NativeChatBotCardKind]: OnPhone[K] extends 'phoneFallback'
    ? 'phoneFallback'
    : (card: NativeChatBotCardValues[K], context: Context) => Render
}
