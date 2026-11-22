import { useCallback, type ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { botChatIdLabel } from '../native-chat/native-chat-markdown-mentions'
import { useBotChatTree } from './use-bot-chat-tree'

/** A sent chat pick's title as the bot's chat list on its host reads now, by id: a renamed chat shows
 *  its new title; one the list doesn't have shows by its id. */
function BotChatMentionTitle({
  hostId,
  botId,
  chatId
}: {
  hostId: ExecutionHostId | null
  botId: string
  chatId: string
}): React.JSX.Element {
  const t = useTranslate()
  const bots = useBots(useBotsEnabled() && hostId !== null)
  const bot = bots.find((entry) => entry.hostId === hostId && entry.id === botId) ?? null
  const chat = useBotChatTree(bot).chats.find((entry) => entry.chatId === chatId)
  if (!chat) {
    return <>{botChatIdLabel(chatId)}</>
  }
  return <>{chat.title || t('bots.chats.untitled', 'New chat')}</>
}

/** Renders a sent chat pick's title, read from the bots on the computer the chat's agent runs on. */
export function useBotChatMentionTitle(
  hostId: ExecutionHostId | null
): (botId: string, chatId: string) => ReactNode {
  return useCallback(
    (botId: string, chatId: string) => (
      <BotChatMentionTitle hostId={hostId} botId={botId} chatId={chatId} />
    ),
    [hostId]
  )
}
