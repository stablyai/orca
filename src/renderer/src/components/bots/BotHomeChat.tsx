import { useEffect } from 'react'
import { openBotChat } from '@/lib/bot-catalog'
import { useBotForWorkspace } from './bot-workspace'
import { useAppStore } from '@/store'
import { isBotHomeTab, isLocalBotChatTab } from '../../../../shared/bots/bot-home-tab'

/** A bot's page always has its Home tab; the runtime keeps the Chat or makes a new one, e.g. after an agent change. */
export function BotHomeChat({ workspaceId }: { workspaceId: string }): null {
  const bot = useBotForWorkspace(workspaceId)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const agent = bot?.agent ?? null
  const local = hostId === 'local'
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
      openBotChat({ hostId, id: botId }).catch((error: unknown) =>
        console.error('Failed to open the bot chat:', error)
      )
    }
  }, [botId, hostId, agent, sessionId, ready, shown])
  return null
}
