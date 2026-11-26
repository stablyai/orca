import { useEffect } from 'react'
import { toast } from 'sonner'
import { openBotChat } from '@/lib/bot-catalog'
import { useBotForWorkspace } from './bot-workspace'
import { botErrorMessage } from './bot-presentation'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session/failures/agent-session-write-failure'
import { useAppStore } from '@/store'
import { isBotHomeTab, isLocalBotChatTab } from '../../../../shared/bots/bot-home-tab'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { revealSharedBotChat } from '@/lib/agent-session/open/shared-bot-chat-open'
import { useBotHostDown } from '@/lib/bot-host-views'

/** A bot's page always has its Home tab, this account's own on a shared agent; the runtime keeps the
 *  Chat or makes a new one, e.g. after an agent change. */
export function BotHomeChat({ workspaceId }: { workspaceId: string }): null {
  const bot = useBotForWorkspace(workspaceId)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const agent = bot?.agent ?? null
  // This computer's agent; another host's Home tab arrives from that host.
  const local = bot !== null && bot.hostId === LOCAL_EXECUTION_HOST_ID
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
  // Asked again once an away or connecting host is live.
  const down = useBotHostDown(hostId ?? LOCAL_EXECUTION_HOST_ID) !== null
  useEffect(() => {
    if (!botId || !hostId || !ready || shown || down) {
      return
    }
    // Left the page meanwhile: its tab must not pull the user back.
    let left = false
    openBotChat({ hostId, id: botId })
      .then((opened) => {
        if (!left) {
          revealSharedBotChat({ hostId }, workspaceId, opened)
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to open the bot chat:', error)
        // A refused Home says why once per bot; a dropped call still retries quietly on the next change.
        if (readAgentSessionErrorRefusal(error)) {
          toast.error(botErrorMessage(error), { id: `bot-home-refused:${botId}` })
        }
      })
    return () => {
      left = true
    }
  }, [botId, hostId, agent, sessionId, ready, shown, down, workspaceId])
  return null
}
