// The Items filter: an icon in the header opening one chat and Needs you only; while a filter is on, a
// dot on the icon and a removable chip per filter under the header.
import { Check, House, ListFilter, MessageSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import type { BotItemChatChoice, BotItemFilter } from '../../../../../shared/bots/bot-item-groups'

function chatName(chat: Pick<BotItemChatChoice, 'title' | 'kind'>, t: Translate): string {
  return chat.kind === 'home'
    ? t('bots.items.homeChat', 'Home Chat')
    : (chat.title ?? t('bots.items.chatFallback', 'Chat'))
}

function ChatIcon({ kind }: { kind: BotItemChatChoice['kind'] }): React.JSX.Element {
  return kind === 'home' ? <House /> : <MessageSquare />
}

export function BotItemsFilterButton({
  items,
  chats,
  filter,
  onFilter
}: {
  items: readonly BotItem[]
  chats: readonly BotItemChatChoice[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
}): React.JSX.Element {
  const t = useTranslate()
  const needsYou = items.filter((item) => item.status === 'needs_you').length
  const label = t('bots.items.filter.label', 'Filter items')
  const on = filter.chatId !== null || filter.needsYou
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={label} className="relative">
              <ListFilter />
              {on ? (
                <span
                  aria-hidden
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-foreground"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>{t('bots.items.filter.chat', 'Chat')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onFilter({ ...filter, chatId: null })}>
          <span className="flex-1">{t('bots.items.filter.all', 'All chats')}</span>
          {filter.chatId === null ? <Check className="size-3" /> : null}
        </DropdownMenuItem>
        {chats.map((chat) => (
          <DropdownMenuItem
            key={chat.chatId}
            onSelect={() => onFilter({ ...filter, chatId: chat.chatId })}
          >
            <ChatIcon kind={chat.kind} />
            <span className="min-w-0 flex-1 truncate">{chatName(chat, t)}</span>
            {chat.count > 0 ? (
              <span className="text-2xs tabular-nums text-muted-foreground">{chat.count}</span>
            ) : null}
            {filter.chatId === chat.chatId ? <Check className="size-3" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filter.needsYou}
          onCheckedChange={(checked) => onFilter({ ...filter, needsYou: checked === true })}
        >
          <span className="flex-1">{t('bots.items.filter.needsYou', 'Needs you only')}</span>
          <span className="text-2xs tabular-nums text-muted-foreground">{needsYou}</span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Chip({
  icon,
  name,
  onClear
}: {
  icon?: React.ReactNode
  name: string
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-input pl-2 pr-0.5 text-xs [&_svg]:size-3">
      {icon}
      <span className="min-w-0 truncate">{name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5"
        aria-label={t('bots.items.filter.remove', 'Remove filter {{name}}', { name })}
        onClick={onClear}
      >
        <X className="size-3" />
      </Button>
    </span>
  )
}

export function BotItemsFilterChips({
  chats,
  filter,
  onFilter
}: {
  chats: readonly BotItemChatChoice[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (filter.chatId === null && !filter.needsYou) {
    return null
  }
  const chat = chats.find((entry) => entry.chatId === filter.chatId)
  return (
    <div className="flex flex-wrap gap-1 px-2">
      {filter.chatId !== null ? (
        <Chip
          icon={<ChatIcon kind={chat?.kind ?? 'chat'} />}
          name={chat ? chatName(chat, t) : t('bots.items.chatFallback', 'Chat')}
          onClear={() => onFilter({ ...filter, chatId: null })}
        />
      ) : null}
      {filter.needsYou ? (
        <Chip
          name={t('bots.items.status.needsYou', 'Needs you')}
          onClear={() => onFilter({ ...filter, needsYou: false })}
        />
      ) : null}
    </div>
  )
}
