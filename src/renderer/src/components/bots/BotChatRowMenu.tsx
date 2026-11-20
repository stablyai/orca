// A bot chat row's menu, the same from its ⋯ and a right-click, in the Chats tab and the sidebar:
// Open, then Delete chat (Clear chat on the live Home), off with the reason while it can't go.
import type React from 'react'
import { ArrowUpRight, Ellipsis, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MenuItemBlockedReason } from '@/components/ui/menu-item-blocked-reason'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  orcaChatDeleteBlockedReason,
  useDeleteOrcaChat,
  useOrcaChatDeleteHostReason
} from '@/lib/agent-session/chat-deletion/orca-chat-delete'
import type { Bot } from '../../../../shared/bot-types'
import { chatRunningCount, type BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'

type MenuKind = 'dropdown' | 'context'

function BotChatMenuItems({
  bot,
  chat,
  kind,
  onOpen
}: {
  bot: Bot
  chat: BotChatTreeChat
  kind: MenuKind
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const deleteChat = useDeleteOrcaChat()
  const hostReason = useOrcaChatDeleteHostReason(bot.hostId)
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  const home = chat.origin === 'home' && !chat.closed
  const label = home ? t('bots.chats.clear', 'Clear chat') : t('bots.chats.delete', 'Delete chat')
  const reason =
    orcaChatDeleteBlockedReason({
      replying: chat.live === 'replying',
      workersRunning: chat.runningTotal > 0 || chatRunningCount(chat) > 0
    }) ?? hostReason
  return (
    <>
      <Item onSelect={onOpen}>
        <ArrowUpRight className="size-3.5" />
        {t('bots.chats.open', 'Open')}
      </Item>
      <Separator />
      <MenuItemBlockedReason
        reason={reason}
        label={label}
        side={kind === 'context' ? 'right' : 'left'}
        render={(blocked) => (
          <Item
            variant="destructive"
            {...blocked}
            onSelect={
              reason
                ? undefined
                : () =>
                    void deleteChat({
                      hostId: bot.hostId,
                      sessionId: chat.chatId,
                      ...(home ? { home: { botName: bot.name } } : {})
                    })
            }
          >
            <Trash2 className="size-3.5" />
            {label}
          </Item>
        )}
      />
    </>
  )
}

/** Whether the row offers the menu: a terminal-only run has no chat to delete. */
export function botChatHasMenu(chat: BotChatTreeChat): boolean {
  return !chat.run
}

/** Right-click on the row opens the menu. */
export function BotChatContextMenu({
  bot,
  chat,
  onOpen,
  children
}: {
  bot: Bot
  chat: BotChatTreeChat
  onOpen: () => void
  children: React.ReactElement
}): React.JSX.Element {
  if (!botChatHasMenu(chat)) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <BotChatMenuItems bot={bot} chat={chat} kind="context" onOpen={onOpen} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The row's ⋯, shown on hover, focus or while open; rows using it carry `group/bot-chat`. */
export function BotChatMoreButton({
  bot,
  chat,
  onOpen,
  className
}: {
  bot: Bot
  chat: BotChatTreeChat
  onOpen: () => void
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!botChatHasMenu(chat)) {
    return null
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('bots.chats.actions', 'Chat actions')}
          className={cn(
            // Positioned, so it sits over a row's own full-size button.
            'relative opacity-0 group-hover/bot-chat:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            className
          )}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <BotChatMenuItems bot={bot} chat={chat} kind="dropdown" onOpen={onOpen} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
