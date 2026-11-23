import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useAccessRequests } from '@/lib/bot-access-requests'
import type { Bot } from '../../../../shared/bot-types'
import type { HostAccessRequest } from '@/lib/bot-access-requests'
import {
  botNeedsYouCount,
  botNow,
  type BotNeed,
  type BotNow
} from '../../../../shared/bots/bot-now'
import { useListedBotItemsNeedingOwner } from '@/lib/bot-catalog'
import { usePublishBotNeedsYou } from './bot-needs-you-published'
import { useBotActivity } from './use-bot-activity'
import { useBotChatTree } from './use-bot-chat-tree'
import { useBotConnectorEntries, type BotConnectorEntry } from './bot-connector-entries'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { usePairedServerAsks } from './use-paired-server-asks'

export type BotNowView = BotNow<BotConnectorEntry, HostAccessRequest>
export type BotNeedView = BotNeed<BotConnectorEntry, HostAccessRequest>

/** What needs the owner and what is working, for the panel header, Activity tab and list, and panel toggle. */
export function useBotNow(bot: Bot | null): BotNowView {
  const activity = useBotActivity(bot)
  const chatState = useAppStore((s) =>
    bot?.chatSessionId
      ? (s.agentStatusByPaneKey.get(chatPaneKey(bot.chatSessionId))?.state ?? null)
      : null
  )
  const { chats } = useBotChatTree(bot)
  const waitingSideChats = useMemo(
    () =>
      chats.flatMap((chat) =>
        chat.origin === 'side' && chat.live === 'needs-you' && !chat.closed
          ? [{ sessionId: chat.chatId, title: chat.title }]
          : []
      ),
    [chats]
  )
  const entries = useBotConnectorEntries(bot)
  const connectors = useMemo(() => entries.filter((entry) => entry.needsOwner), [entries])
  const requests = useAccessRequests()
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const accessRequests = useMemo(
    () => requests.filter((request) => request.botId === botId && request.hostId === hostId),
    [requests, botId, hostId]
  )
  const pairedAsks = usePairedServerAsks(bot)
  return useMemo(
    () => botNow({ activity, chatState, connectors, accessRequests, waitingSideChats, pairedAsks }),
    [activity, chatState, connectors, accessRequests, waitingSideChats, pairedAsks]
  )
}

/** The bot's Needs you count, unfiltered (`botNeedsYouCount`): the Items tab badge, the panel toggle,
 *  the header's dot and its line's count all read this. */
export function useBotNeedsYouCount(bot: Bot | null, now: Pick<BotNowView, 'needsYou'>): number {
  // The host's own count, sent with each items change: no surface reads the item list for it.
  const count = botNeedsYouCount(now.needsYou, useListedBotItemsNeedingOwner(bot) ?? 0)
  // The sidebar row and Cmd+J say this number too, without reads of their own.
  usePublishBotNeedsYou(bot, count)
  return count
}
