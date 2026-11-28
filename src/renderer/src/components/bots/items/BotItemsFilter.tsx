import { useState } from 'react'
import { ListFilter, X } from 'lucide-react'
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
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { BotAvatar } from '../BotAvatar'
import { isBotItemFilterOn, type BotItemFilter } from '../../../../../shared/bots/bot-item-groups'

/** A chat's name as a group's rows say it: Home Chat, else its title. */
export function botItemChatName(
  chat: Pick<BotItem['chat'], 'title' | 'kind'>,
  t: Translate
): string {
  return chat.kind === 'home'
    ? t('bots.items.homeChat', 'Home Chat')
    : (chat.title ?? t('bots.items.chatFallback', 'Chat'))
}

/** What a group's menu adds: a Bot section, Clear filters, and a
 *  tooltip naming the filter. */
export type BotItemsFilterGroup = {
  bots: readonly { bot: Bot; count: number }[]
  /** The default Clear filters goes back to. */
  cleared: BotItemFilter
  /** What the filter shows ("Bo · Needs you only"); null at the default. */
  named: string | null
}

export function BotItemsFilterButton({
  items,
  filter,
  onFilter,
  group = null
}: {
  /** The items "Needs you only" counts. */
  items: readonly BotItem[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
  group?: BotItemsFilterGroup | null
}): React.JSX.Element {
  const t = useTranslate()
  const needsYou = items.filter((item) => item.status === 'needs_you').length
  const label = t('bots.items.filter.label', 'Filter items')
  const on = group ? group.named !== null : isBotItemFilterOn(filter)
  // Checked bots lead, in the order they had as the menu opened, so rows don't jump under the pointer.
  const [botOrder, setBotOrder] = useState<readonly string[]>([])
  const orderBots = (): void =>
    setBotOrder(
      (group?.bots ?? [])
        .map(({ bot }) => bot.id)
        .toSorted(
          (a, b) =>
            Number(filter.botIds?.includes(b) ?? false) -
            Number(filter.botIds?.includes(a) ?? false)
        )
    )
  const bots = group
    ? group.bots.toSorted((a, b) => botOrder.indexOf(a.bot.id) - botOrder.indexOf(b.bot.id))
    : []
  const toggleBot = (id: string, checked: boolean): void => {
    const rest = (filter.botIds ?? []).filter((entry) => entry !== id)
    const next = checked ? [...rest, id] : rest
    onFilter({ ...filter, botIds: next.length > 0 ? next : null })
  }
  return (
    <DropdownMenu onOpenChange={(open) => open && orderBots()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                group?.named
                  ? t('bots.groups.items.filterNamed', 'Filter items, filtered by {{filter}}', {
                      filter: group.named
                    })
                  : label
              }
              className="relative"
            >
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
          {group?.named ? `${label} · ${group.named}` : label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        {group ? (
          <>
            <DropdownMenuLabel>{t('bots.groups.items.filterBot', 'Bot')}</DropdownMenuLabel>
            <div className="scrollbar-sleek max-h-[12.5rem] overflow-y-auto">
              {bots.map(({ bot, count }) => (
                <DropdownMenuCheckboxItem
                  key={bot.id}
                  checked={filter.botIds?.includes(bot.id) ?? false}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => toggleBot(bot.id, checked === true)}
                >
                  <BotAvatar bot={bot} className="size-4 shrink-0 rounded-full text-[9px]" />
                  <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  {count > 0 ? (
                    <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>
                  ) : null}
                </DropdownMenuCheckboxItem>
              ))}
            </div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={filter.needsYou}
          onCheckedChange={(checked) => onFilter({ ...filter, needsYou: checked === true })}
        >
          <span className="flex-1">{t('bots.items.filter.needsYou', 'Needs you only')}</span>
          <span className="text-2xs tabular-nums text-muted-foreground">{needsYou}</span>
        </DropdownMenuCheckboxItem>
        {group && on ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onFilter(group.cleared)}>
              <X />
              {t('bots.items.filter.clearAll', 'Clear filters')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The bot page's chip for Needs you only, removing it. */
export function BotItemsFilterChips({
  filter,
  onFilter
}: {
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!filter.needsYou) {
    return null
  }
  const name = t('bots.items.status.needsYou', 'Needs you')
  return (
    <div className="flex flex-wrap gap-1 px-2">
      <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-input pl-2 pr-0.5 text-xs">
        <span className="min-w-0 truncate">{name}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5"
          aria-label={t('bots.items.filter.remove', 'Remove filter {{name}}', { name })}
          onClick={() => onFilter({ ...filter, needsYou: false })}
        >
          <X className="size-3" />
        </Button>
      </span>
    </div>
  )
}
