// The one test for "this tab is the bot's Home": placement, locks, pin rules and the banner all ask it.
import type { Bot } from '../bot-types'
import type { Tab } from '../workspace-layout/tab-groups/tab-types'

type ChatTab = Pick<Tab, 'contentType' | 'entityId'>

/** The bot whose page holds `tab` is `bot`; Home is the chat its one pointer names. */
export function isBotHomeTab(tab: ChatTab, bot: Pick<Bot, 'chatSessionId'> | null): boolean {
  return (
    bot !== null &&
    bot.chatSessionId !== null &&
    tab.contentType === 'agent-session' &&
    tab.entityId === bot.chatSessionId
  )
}

/** Every other chat on a bot's page is one of its side chats; only Home may sit pinned at the left. */
export function isBotSideChatTab(tab: ChatTab, bot: Pick<Bot, 'chatSessionId'> | null): boolean {
  return bot !== null && tab.contentType === 'agent-session' && !isBotHomeTab(tab, bot)
}
