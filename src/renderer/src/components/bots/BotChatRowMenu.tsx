// A bot chat row's menu, the same from its ⋯ and a right-click, in the Chats tab and the sidebar:
// Open, then Delete chat (stopping it when it runs), off with the reason while it can't go. The live
// Home, where the agent's mail and connectors land, has no Delete.
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
  useDeleteOrcaChat,
  useOrcaChatDeleteHostReason
} from '@/lib/agent-session/chat-deletion/orca-chat-delete'
import type { Bot } from '../../../../shared/bot-types'
import { botChatOffersDelete, type BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'

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
  const label = t('bots.chats.delete', 'Delete chat')
  return (
    <>
      <Item onSelect={onOpen}>
        <ArrowUpRight className="size-3.5" />
        {t('bots.chats.open', 'Open')}
      </Item>
      {botChatOffersDelete(chat) ? (
        <>
          <Separator />
          <DeleteItem
            label={label}
            reason={hostReason}
            kind={kind}
            onDelete={() => void deleteChat({ hostId: bot.hostId, sessionId: chat.chatId })}
          />
        </>
      ) : null}
    </>
  )
}

function DeleteItem({
  label,
  reason,
  kind,
  onDelete
}: {
  label: string
  reason: string | null
  kind: MenuKind
  onDelete: () => void
}): React.JSX.Element {
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <MenuItemBlockedReason
      reason={reason}
      label={label}
      side={kind === 'context' ? 'right' : 'left'}
      render={(blocked) => (
        <Item variant="destructive" {...blocked} onSelect={reason ? undefined : onDelete}>
          <Trash2 className="size-3.5" />
          {label}
        </Item>
      )}
    />
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
      {/* Shown on hover, focus or while open. */}
      <span
        data-chat-menu=""
        className={cn(
          'opacity-0 group-hover/bot-chat:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
          className
        )}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost-on-accent"
            size="icon-xs"
            aria-label={t('bots.chats.actions', 'Chat actions')}
            // Positioned, so it sits over a row's own full-size button.
            className="relative"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </span>
      {/* React bubbles portal events to the row, which would open the chat on a menu pick. */}
      <DropdownMenuContent
        align="end"
        className="w-44"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <BotChatMenuItems bot={bot} chat={chat} kind="dropdown" onOpen={onOpen} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
