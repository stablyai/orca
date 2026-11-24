// What a tool-added row shows: the tool as the host has it now, since the card's copy is from when
// it was added. Each platform draws it and passes its translations.
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'

export const BOT_TOOL_ADDED_CARD_COPY = {
  added: 'Added',
  removed: 'Removed',
  remove: 'Remove'
} as const

export type BotToolAddedCardSay = BotCardSay<keyof typeof BOT_TOOL_ADDED_CARD_COPY>

export type BotToolAddedCardView = {
  /** The words before the tool's name: Added, or Removed once the bot no longer has it. */
  lead: string
  /** After the name while it is on the bot: its subtitle and sign-in line. */
  after: string[]
  /** Still on the bot: its sign-in action and Remove show. */
  present: boolean
}

export function botToolAddedCardView(
  /** Whether the bot still has the tool as the host has it now; null until read. */
  present: boolean | null,
  subtitle: string | null,
  /** The platform's sign-in line for the tool, when it needs one. */
  signInLine: string | null,
  say: BotToolAddedCardSay
): BotToolAddedCardView {
  const removed = present === false
  return {
    lead: removed ? say('removed') : say('added'),
    after: removed ? [] : [subtitle, signInLine].filter((part): part is string => Boolean(part)),
    present: present === true
  }
}
