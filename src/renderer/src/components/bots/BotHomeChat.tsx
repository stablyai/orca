import { useEffect } from 'react'
import { openBotChat } from '@/lib/bot-catalog'
import { useBotForWorkspace } from './bot-workspace'

/** A bot's page always has its Home tab; the runtime keeps the Chat or makes a new one, e.g. after an agent change. */
export function BotHomeChat({ workspaceId }: { workspaceId: string }): null {
  const bot = useBotForWorkspace(workspaceId)
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const agent = bot?.agent ?? null
  useEffect(() => {
    if (botId && hostId) {
      openBotChat({ hostId, id: botId }).catch((error: unknown) =>
        console.error('Failed to open the bot chat:', error)
      )
    }
  }, [botId, hostId, agent])
  return null
}
