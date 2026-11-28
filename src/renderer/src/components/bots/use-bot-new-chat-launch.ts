import { toast } from 'sonner'
import { newBotHomeChat, startBotSession } from '@/lib/bot-catalog'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import { useConfirmNewHomeChat } from './bot-home-chat-confirm'
import { botErrorMessage } from './bot-presentation'
import { startAndOpenBotChat } from './bot-session-open'

export type BotNewChatLaunch = {
  /** A side chat with the bot on `agent`. */
  startSideChat: (agent: BotAgent) => void
  /** A fresh Home Chat, once the owner confirms. */
  newHomeChat: () => Promise<void>
}

/** Starts the bot's chats from its home's + menu, whether picked from the list or the search. */
export function useBotNewChatLaunch(bot: Bot): BotNewChatLaunch {
  const confirmNewHomeChat = useConfirmNewHomeChat()
  // Opens the tab here as well as on the host, refreshing the tab list if it has not arrived yet.
  const opened = (start: () => Promise<string>): void =>
    startAndOpenBotChat(bot, start, (error) => toast.error(botErrorMessage(error)))
  return {
    startSideChat: (agent) => opened(() => startBotSession(bot, { agent })),
    newHomeChat: async () => {
      if (await confirmNewHomeChat(bot)) {
        opened(() => newBotHomeChat(bot))
      }
    }
  }
}
