// Whose Home Chat each row of an agent's chats tree is, on its host: the owner's Home row, a teammate's
// made Home, and the placeholder row of a teammate's Home not made yet that holds their closed chat's work.
import type { BotChatTreeChat, BotChatTreeRead } from './bot-chat-tree'
import type { BotChatFacts, BotChatTreeDispatch, BotChatTreePlaced } from './bot-chat-tree-model'
import {
  botHomePlaceholderAccount,
  botHomePlaceholderId,
  sameBotHome,
  type BotHomeOf
} from './bot-home-of'

/** The id an agent without a Home Chat yet lists its Home row by; opening it starts one. */
export const NO_HOME_CHAT_ID = ''

/** The Home row's title, the name the agent's Home tab goes by. */
export const HOME_CHAT_TITLE = 'Home Chat'

/** On the agent's host, before a viewer's projection: whose Home Chat a chat is, by identity. */
type WhoseHome = { whoseHome?: BotHomeOf }
export type BotChatHostFacts = BotChatFacts & WhoseHome
export type BotChatHostChat = BotChatTreeChat & WhoseHome
export type BotChatHostTree = Omit<BotChatTreeRead, 'chats'> & { chats: BotChatHostChat[] }

/** The row a person's work shows under: the owner's Home row, a teammate's open Home, else that
 *  teammate's placeholder, never the owner's. */
function botChatHomeRow(
  chats: readonly BotChatHostFacts[],
  ownerHome: string,
  of: BotHomeOf
): string {
  if (of === 'owner') {
    return ownerHome
  }
  const made = chats.find(
    (chat) => chat.whoseHome && sameBotHome(chat.whoseHome, of) && !chat.closed
  )
  return made?.chatId ?? botHomePlaceholderId(of.accountId)
}

/** A Home row with nothing in it yet; opening it starts that Home. */
export function idleHomeRow(chatId: string): BotChatHostFacts {
  return {
    chatId,
    title: HOME_CHAT_TITLE,
    origin: 'home',
    live: 'idle',
    lastActiveAt: 0,
    unread: false,
    closed: false
  }
}

/** The placeholder rows the placed work names that no chat lists; each viewer decides how it shows. */
export function botChatHomePlaceholders(
  placedChatIds: readonly string[],
  listed: ReadonlySet<string>
): BotChatHostFacts[] {
  return [...new Set(placedChatIds)].flatMap((chatId): BotChatHostFacts[] => {
    const accountId = botHomePlaceholderAccount(chatId)
    return accountId && !listed.has(chatId)
      ? [{ ...idleHomeRow(chatId), origin: 'side', whoseHome: { accountId } }]
      : []
  })
}

/** The owner's open Home row, else the row their Home not made yet goes by. */
export function ownerHomeRowId(chats: readonly BotChatFacts[]): string {
  return chats.find((chat) => chat.origin === 'home' && !chat.closed)?.chatId ?? NO_HOME_CHAT_ID
}

/** Where each Dispatch shows: its chat; else the Home of the person its chat was for (`homeOf`,
 *  the owner's without it) when its chat is gone, or while its closed chat's worker runs. A teammate
 *  with no Home yet gets their placeholder row, never the owner's. */
export function placeBotChatDispatches(
  chats: readonly BotChatHostFacts[],
  dispatches: readonly BotChatTreeDispatch[],
  homeOf: (chatId: string) => BotHomeOf = () => 'owner'
): BotChatTreePlaced[] {
  const ownerHome = ownerHomeRowId(chats)
  const homeRow = (chatId: string | null): string =>
    botChatHomeRow(chats, ownerHome, chatId ? homeOf(chatId) : 'owner')
  const byId = new Map(chats.map((chat) => [chat.chatId, chat]))
  return dispatches.map((dispatch) => {
    const chat = dispatch.chatId ? byId.get(dispatch.chatId) : undefined
    if (!chat) {
      return { dispatch, chatId: homeRow(dispatch.chatId) }
    }
    if (chat.closed && !dispatch.settled) {
      return { dispatch, chatId: homeRow(chat.chatId), note: 'from-closed-chat' }
    }
    return { dispatch, chatId: chat.chatId }
  })
}
