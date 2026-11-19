// What a bot-request card shows, from the card and Orca's reading of it: its heading, its line, its
// avatar dot and whether it opens the answer. Each platform draws it and passes its translations.
import type { AgentMessageSource } from '../agent-session/journal/agent-session-message-source'
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'
import type { BotRequestCard, BotRequestCardReading } from './bot-request-card'

export const BOT_REQUEST_CARD_COPY = {
  notSentTo: 'Not sent to',
  asked: 'Asked',
  handedTo: 'Handed to',
  paused: '{{bot}} is paused.',
  botsOff: 'Bots are off.',
  couldNotTake: "{{bot}} couldn't take it."
} as const

export type BotRequestCardSay = BotCardSay<keyof typeof BOT_REQUEST_CARD_COPY>

export type BotRequestCardDot = 'done' | 'interrupted' | 'permission' | 'working'

export type BotRequestCardView = {
  heading: string
  /** The subject when sent, else why Orca didn't send it. */
  line: string
  /** Sent: the bot's name opens the chat it went to. */
  sent: boolean
  dot: BotRequestCardDot | null
  /** The answer, which the card opens to show. */
  answer: string | null
  copyText: string
}

// Why Orca didn't send it, for the owner, by refusal code; the bot reads its own sentence.
const REFUSAL_COPY: Record<string, keyof typeof BOT_REQUEST_CARD_COPY> = {
  bot_paused: 'paused',
  bots_disabled: 'botsOff'
}

/** The avatar's dot for a sent request; none for a handoff it kept or a request not sent. */
function requestDot(
  card: BotRequestCard,
  outcome: BotRequestCardReading['outcome'],
  activity: string
): BotRequestCardDot | null {
  if (!card.messageId) {
    return null
  }
  if (outcome === 'answered' || outcome === 'posted') {
    return 'done'
  }
  // A handoff it read and ended its turn on is still its job; only a question goes unanswered.
  if (outcome === 'unanswered' && card.purpose === 'handoff') {
    return null
  }
  if (outcome === 'unanswered' || outcome === 'dropped') {
    return 'interrupted'
  }
  return activity === 'permission' ? 'permission' : 'working'
}

export function botRequestCardView(
  card: BotRequestCard,
  reading: Pick<BotRequestCardReading, 'outcome' | 'answer'>,
  /** The asked bot's workspace activity, for the working or permission dot. */
  activity: string,
  say: BotRequestCardSay
): BotRequestCardView {
  const sent = Boolean(card.messageId)
  const heading = !sent
    ? say('notSentTo')
    : card.purpose === 'question'
      ? say('asked')
      : say('handedTo')
  const refusal =
    card.refusal && Object.hasOwn(REFUSAL_COPY, card.refusal)
      ? REFUSAL_COPY[card.refusal]
      : undefined
  const line = sent ? card.subject : say(refusal ?? 'couldNotTake', { bot: card.toBotName })
  const answer = reading.answer || null
  return {
    heading,
    line,
    sent,
    dot: requestDot(card, reading.outcome, activity),
    answer,
    copyText: [card.subject, answer].filter(Boolean).join('\n\n')
  }
}

const NO_MAIL: readonly string[] = []

/** The mail a "Message from" notice points at, which a request card may already show. */
export function mailNoticeMessageIds(from: AgentMessageSource | undefined): readonly string[] {
  return from?.orchestration?.message === 'mail-notice'
    ? from.orchestration.messages.map((message) => message.messageId)
    : NO_MAIL
}
