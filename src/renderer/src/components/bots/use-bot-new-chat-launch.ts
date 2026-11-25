import { toast } from 'sonner'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { newBotHomeChat, startBotSession } from '@/lib/bot-catalog'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { useConfirmNewHomeChat } from './bot-home-chat-confirm'
import { botErrorMessage } from './bot-presentation'

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
  const opened = (session: Promise<string>): void => {
    void session
      .then((sessionId) =>
        activateAiVaultStructuredSession({
          structuredSession: { workspaceId: folderWorkspaceKey(bot.folderWorkspaceId), sessionId }
        })
      )
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  return {
    startSideChat: (agent) => opened(startBotSession(bot, { agent })),
    newHomeChat: async () => {
      if (await confirmNewHomeChat(bot)) {
        opened(newBotHomeChat(bot))
      }
    }
  }
}
