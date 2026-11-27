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
import {
  botItemsPersonPick,
  botPickedOther,
  sameBotPersonPick,
  type BotChatPersonPick
} from '../../../../../shared/bots/bot-chat-people'
import { BotAvatar } from '../BotAvatar'
import {
  BotPersonPickItems,
  botPersonPickName,
  type BotPersonPickLabelled
} from '../BotPersonPickItems'
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

/** A shared bot's person pick, leading the bot page's menu. */
export type BotItemsPeople = {
  /** The viewer first, then everyone else. */
  entries: readonly BotPersonPickLabelled[]
  pick: BotChatPersonPick
  onPick: (pick: BotChatPersonPick) => void
}

export function BotItemsFilterButton({
  items,
  filter,
  onFilter,
  group = null,
  people = null
}: {
  /** The items "Needs you only" counts. */
  items: readonly BotItem[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
  group?: BotItemsFilterGroup | null
  people?: BotItemsPeople | null
}): React.JSX.Element {
  const t = useTranslate()
  const needsYou = items.filter((item) => item.status === 'needs_you').length
  const label = t('bots.items.filter.label', 'Filter items')
  const person = people ? botPersonPickName(people.pick, people.entries) : null
  const named = group?.named ?? person
  const on = group
    ? group.named !== null
    : isBotItemFilterOn(filter) ||
      (people !== null && !sameBotPersonPick(people.pick, botItemsPersonPick(people.entries, null)))
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
                named
                  ? t('bots.groups.items.filterNamed', 'Filter items, filtered by {{filter}}', {
                      filter: named
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
          {named ? `${label} · ${named}` : label}
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
        {people ? (
          <>
            <BotPersonPickItems
              entries={people.entries}
              pick={people.pick}
              onPick={people.onPick}
            />
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

function FilterChip({ name, onRemove }: { name: string; onRemove: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-input pl-2 pr-0.5 text-xs">
      <span className="min-w-0 truncate">{name}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5"
        aria-label={t('bots.items.filter.remove', 'Remove filter {{name}}', { name })}
        onClick={onRemove}
      >
        <X className="size-3" />
      </Button>
    </span>
  )
}

/** The bot page's chips, each removing its filter: another person picked (back to the viewer's own, the
 *  default) and Needs you only. */
export function BotItemsFilterChips({
  filter,
  onFilter,
  people = null
}: {
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
  people?: BotItemsPeople | null
}): React.JSX.Element | null {
  const t = useTranslate()
  // Another person than the viewer's own, the default: by name, removing back to the viewer's own.
  const own = people?.entries[0]
  const other = people ? (botPickedOther(people.pick, people.entries)?.label ?? null) : null
  if (!filter.needsYou && !other) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-1 px-2">
      {other && people && own ? (
        <FilterChip name={other} onRemove={() => people.onPick(own.pick)} />
      ) : null}
      {filter.needsYou ? (
        <FilterChip
          name={t('bots.items.status.needsYou', 'Needs you')}
          onRemove={() => onFilter({ ...filter, needsYou: false })}
        />
      ) : null}
    </div>
  )
}
