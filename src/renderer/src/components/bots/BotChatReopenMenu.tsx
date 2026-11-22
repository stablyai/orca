import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { reopenBotChat } from './bot-chat-reopen'

/** A chat Orca closed: its row's right-click menu reopens it in place. Any other row is left as is. */
export function BotChatReopenMenu({
  bot,
  chat,
  children
}: {
  bot: Bot
  chat: Pick<BotChatTreeChat, 'chatId' | 'closed' | 'autoClosedAt'>
  children: React.ReactElement
}): React.JSX.Element {
  const t = useTranslate()
  if (!chat.closed || !chat.autoClosedAt) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => reopenBotChat(bot, chat.chatId)}>
          {t('bots.chats.autoClose.reopen', 'Reopen')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
