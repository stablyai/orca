import { useEffect } from 'react'
import { toast } from 'sonner'
import { openBotChat } from '@/lib/bot-catalog'
import { useBotForWorkspace } from './bot-workspace'
import { botErrorMessage } from './bot-presentation'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session/failures/agent-session-write-failure'
import { useAppStore } from '@/store'
import { isBotHomeTab, isLocalBotChatTab } from '../../../../shared/bots/bot-home-tab'
import { botHomeHostId } from '../../../../shared/bots/bot-home-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { openSharedBotChat } from '@/lib/agent-session/open/shared-bot-chat-open'

/** A bot's page always has its Home tab, this account's own on a shared agent; the runtime keeps the
 *  Chat or makes a new one, e.g. after an agent change. */
export function BotHomeChat({ workspaceId }: { workspaceId: string }): null {
  const bot = useBotForWorkspace(workspaceId)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const agent = bot?.agent ?? null
  // Its tabs live here: this computer's agent, or one shared with this account.
  const local = bot !== null && botHomeHostId(bot) === LOCAL_EXECUTION_HOST_ID
  const sessionId = local ? (bot?.chatSessionId ?? null) : null
  const ready = useAppStore((state) => !local || state.workspaceSessionReady)
  const shown = useAppStore(
    (state) =>
      local &&
      (state.unifiedTabsByWorktree[workspaceId] ?? []).some(
        (tab) =>
          isLocalBotChatTab(tab, bot) && isBotHomeTab(tab, bot) && tab.agentSessionAgent === agent
      )
  )
  useEffect(() => {
    if (botId && hostId && ready && !shown) {
      openBotChat({ hostId, id: botId })
        // A shared agent's host keeps no tabs for this account: its Home's tab is kept here.
        .then((opened) => openSharedBotChat({ workspaceId, sessionId: opened }))
        .catch((error: unknown) => {
          console.error('Failed to open the bot chat:', error)
          // A refused Home says why once per bot; a dropped call still retries quietly on the next change.
          if (readAgentSessionErrorRefusal(error)) {
            toast.error(botErrorMessage(error), { id: `bot-home-refused:${botId}` })
          }
        })
    }
  }, [botId, hostId, agent, sessionId, ready, shown, workspaceId])
  return null
}
