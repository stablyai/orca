// What a tool-added card shows: the tool as the host has it now, since the card's copy is from when
// it was added. Each platform draws it and passes its translations.
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'

export const BOT_TOOL_ADDED_CARD_COPY = {
  heading: 'Added a tool',
  removed: 'Removed',
  remove: 'Remove'
} as const

export type BotToolAddedCardSay = BotCardSay<keyof typeof BOT_TOOL_ADDED_CARD_COPY>

export type BotToolAddedCardView = {
  /** The tool's state after its subtitle: removed, or its sign-in line. */
  state: string | null
  /** Still on the bot: its sign-in action and Remove show. */
  present: boolean
}

export function botToolAddedCardView(
  /** Whether the bot still has the tool as the host has it now; null until read. */
  present: boolean | null,
  /** The platform's sign-in line for the tool, when it needs one. */
  signInLine: string | null,
  say: BotToolAddedCardSay
): BotToolAddedCardView {
  return {
    state: present === false ? say('removed') : signInLine,
    present: present === true
  }
}
