// Each bot's own side chats as its host classes them, read once per host for every bot's row (then only
// for the bots a change names), so even a folded row says what any of its chats is doing.
import type { BotRowLineChat } from '../../../shared/bots/bot-row-line'
import { BOT_CHATS_OWN_MAX_IDS } from '../../../shared/rpc-contract/bot-chats-params'
import { createBotHostPerBotRead } from './bot-host-per-bot-read'
import type { BotRef } from './bot-hosts'

const sameChats = (a: readonly BotRowLineChat[], b: readonly BotRowLineChat[]) =>
  a.length === b.length &&
  a.every((chat, i) => chat.paneKey === b[i]?.paneKey && chat.title === b[i]?.title)

const ownChats = createBotHostPerBotRead<
  readonly BotRowLineChat[],
  { chats: Record<string, BotRowLineChat[]> }
>({
  method: 'bots.chats.own',
  // A chat's record (created, renamed, ended) or a thread link turning it into a thread.
  kinds: ['chats', 'threads', 'bot'],
  pick: (answer) => answer.chats,
  same: sameChats,
  scoped: { maxIds: BOT_CHATS_OWN_MAX_IDS }
})

/** Undefined until read, and from a host without the method. */
export function useBotOwnChats(bot: BotRef | null): readonly BotRowLineChat[] | undefined {
  return ownChats.useValue(bot)
}
