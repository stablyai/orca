// Hover or keyboard focus swaps the age for Done, Snooze, and More on open items.
import { useId } from 'react'
import { Check, CircleCheck, CircleSlash, Clock, MoreHorizontal } from 'lucide-react'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMenuPointerExitClose } from '@/components/ui/menu-pointer-exit-close'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import {
  botItemActivityAt,
  isBotItemLive,
  type BotItem
} from '../../../../../shared/bots/bot-items'
import type { Bot } from '../../../../../shared/bot-types'
import { BotRowHoverCard } from '../BotPanelRow'
import { BotItemNumberColumn } from './BotItemNumberColumn'
import { BotItemRowFace } from './BotItemRowFace'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { BOT_ITEM_ROW_ACTION_OVERLAY } from './bot-item-row-hover-actions'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from './BotItemSnooze'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'

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
  onAction,
  face = null,
  place = null
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
  /** Its bot, in a group's merged list. */
  face?: Bot | null
  /** Its chat's name, when the list shows chats beyond the one it is about. */
  place?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const closed = item.status === 'done' || item.status === 'canceled'
  const doneLabel = t('bots.items.row.done', 'Done')
  const snoozeLabel = t('bots.items.snooze.menu', 'Snooze')
  // Needs you's question shows in the row's hover card; the row stays one line like the others.
  const question = !stale && !snoozed && item.status === 'needs_you' ? item.question?.text : null
  const questionId = useId()
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
        'group/item relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent has-[[aria-expanded=true]]:bg-accent',
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
      {face ? <BotItemRowFace bot={face} /> : null}
      <BotRowHoverCard
        card={
          question ? (
            <>
              <p className="font-medium text-foreground">{item.title}</p>
              <CommentMarkdown
                content={question}
                className="mt-1 text-xs leading-4 text-muted-foreground"
              />
            </>
          ) : null
        }
      >
        <button
          type="button"
          data-bot-item-open=""
          title={question ? undefined : item.title}
          aria-describedby={question ? questionId : undefined}
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
                      'group-has-[:focus-visible]/item:invisible group-hover/item:invisible group-has-[[aria-expanded=true]]/item:invisible'
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
              {/* A group's list names the chat a row is from on a quiet second line. */}
              {place ? (
                <span className="block truncate text-xs leading-4 text-muted-foreground">
                  {place}
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </BotRowHoverCard>
      {question ? (
        <span id={questionId} hidden>
          {question}
        </span>
      ) : null}
      {closed ? null : (
        // Keep actions in the tab order so focus can move from the title to an action.
        <span
          className={cn(
            BOT_ITEM_ROW_ACTION_OVERLAY,
            'pointer-events-none flex gap-0.5 opacity-0 group-has-[:focus-visible]/item:pointer-events-auto group-has-[:focus-visible]/item:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost-on-accent"
                size="icon-xs"
                aria-label={doneLabel}
                onClick={() => onAction({ kind: 'done' })}
              >
                <Check className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {doneLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost-on-accent" size="icon-xs" aria-label={snoozeLabel}>
                    <Clock className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {snoozeLabel}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} inSubmenu={false} />
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange}>
            <DropdownMenuTrigger asChild ref={triggerRef} {...menu.triggerProps}>
              <Button
                variant="ghost-on-accent"
                size="icon-xs"
                aria-label={t('bots.items.row.more', 'More')}
              >
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
