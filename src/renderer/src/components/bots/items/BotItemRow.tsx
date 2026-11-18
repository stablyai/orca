// One item in a bot's Items tab. Hover or keyboard focus on an open row swaps its age (a snoozed row's wake time)
// for ✓ Done and ⋯ (Done, Snooze, Cancel); hovering its icon shows its checkbox, and once any row is checked every row shows one. A dot
// marks a row that changed since the tab was last opened. A pointer-opened ⋯ menu closes when the
// pointer leaves row and menu.
import { Check, CircleCheck, CircleSlash, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMenuPointerExitClose } from '@/components/ui/menu-pointer-exit-close'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import {
  botItemActivityAt,
  isBotItemLive,
  type BotItem
} from '../../../../../shared/bots/bot-items'
import { BotItemNumberColumn } from './BotItemNumberColumn'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { BOT_ITEM_ROW_HOVER_ACTIONS } from './bot-item-row-hover-actions'
import {
  BotItemSnoozeMenuItems,
  formatBotItemSnoozeTime,
  type BotItemSnoozing
} from './BotItemSnooze'

export type BotItemRowAction = { kind: 'open' } | { kind: 'done' } | { kind: 'cancel' }

export function BotItemRow({
  item,
  stale,
  snoozed = false,
  snoozing,
  unseen,
  selected,
  selecting,
  now,
  onSelect,
  onAction
}: {
  item: BotItem
  stale: boolean
  /** In the Snoozed group: grey like Stale, its wake time where the age goes. */
  snoozed?: boolean
  snoozing: BotItemSnoozing
  unseen: boolean
  selected: boolean
  /** Some row is checked: every row shows its checkbox. */
  selecting: boolean
  now: number
  onSelect: (selected: boolean, range: boolean) => void
  onAction: (action: BotItemRowAction) => void
}): React.JSX.Element {
  const t = useTranslate()
  const closed = item.status === 'done' || item.status === 'canceled'
  // Only Needs you has a second line, the bot's question; In progress's spinner is its live signal.
  const line = !stale && !snoozed && item.status === 'needs_you' ? item.question?.text : null
  const checkbox = selecting || selected
  const { rowRef, triggerRef, ...menu } = useMenuPointerExitClose<
    HTMLDivElement,
    HTMLButtonElement
  >()
  return (
    <div
      ref={rowRef}
      role="listitem"
      data-bot-item={item.number}
      className={cn(
        'group/item relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent has-[[data-state=open]]:bg-accent',
        selected && 'bg-accent'
      )}
    >
      <span className="group/check flex h-5 w-4 shrink-0 items-center justify-center">
        <span className={cn('flex', checkbox ? 'hidden' : 'group-hover/check:hidden')}>
          <BotItemStatusIcon
            status={item.status}
            live={isBotItemLive(item)}
            stale={stale || snoozed}
          />
        </span>
        <Checkbox
          aria-label={t('bots.items.row.select', 'Select {{title}}', { title: item.title })}
          checked={selected}
          className={cn('size-3.5', !checkbox && 'hidden group-hover/check:flex')}
          onClick={(event) => {
            event.preventDefault()
            onSelect(!selected, event.shiftKey)
          }}
        />
      </span>
      <button
        type="button"
        data-bot-item-open=""
        title={item.title}
        className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onAction({ kind: 'open' })}
      >
        <span className="flex min-w-0 items-start">
          <BotItemNumberColumn number={item.number} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] leading-5',
                  closed ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {item.title}
              </span>
              {/* Only open rows have hover actions, so only they give the age up to them. */}
              <span
                className={cn(
                  'flex shrink-0 items-center gap-2',
                  !closed &&
                    'group-has-[:focus-visible]/item:invisible group-hover/item:invisible group-has-[[data-state=open]]/item:invisible'
                )}
              >
                {unseen ? (
                  <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
                ) : null}
                {snoozed && item.snoozedUntil !== null ? (
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {t('bots.items.snooze.rowUntil', 'until {{when}}', {
                      when: formatBotItemSnoozeTime(item.snoozedUntil, now)
                    })}
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground @max-[284px]:hidden">
                    {formatShortTimeAgo(botItemActivityAt(item, now), now)}
                  </span>
                )}
              </span>
            </span>
            {line ? (
              <span className="block truncate text-xs leading-4 text-muted-foreground">{line}</span>
            ) : null}
          </span>
        </span>
      </button>
      {closed ? null : (
        <span className={cn(BOT_ITEM_ROW_HOVER_ACTIONS, 'gap-0.5 has-[[data-state=open]]:flex')}>
          <Button
            variant="ghost"
            size="xs"
            className="h-6"
            onClick={() => onAction({ kind: 'done' })}
          >
            <Check className="size-3" />
            {t('bots.items.row.done', 'Done')}
          </Button>
          <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange}>
            <DropdownMenuTrigger asChild ref={triggerRef} {...menu.triggerProps}>
              <Button variant="ghost" size="icon-xs" aria-label={t('bots.items.row.more', 'More')}>
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" {...menu.contentProps}>
              <DropdownMenuItem onSelect={() => onAction({ kind: 'done' })}>
                <CircleCheck />
                {t('bots.items.menu.done', 'Done')}
              </DropdownMenuItem>
              <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} />
              <DropdownMenuItem onSelect={() => onAction({ kind: 'cancel' })}>
                <CircleSlash />
                {t('bots.items.menu.cancel', 'Cancel…')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </div>
  )
}
