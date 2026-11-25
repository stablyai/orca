// One Needs you item in the inbox: its bot, number and age, its title and the line it asks. Its quick
// replies show only in the item's view beside the list. Done and Snooze sit at its end, as on an Items
// tab row.
import { Check, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemQuestionLine } from '../../../../../shared/bots/bot-item-ask'
import { botItemActivityAt, type BotItem } from '../../../../../shared/bots/bot-items'
import { BotAvatar } from '../BotAvatar'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from '../items/BotItemSnooze'

/** The line the item asks: its first question line, else its question's gist (a host before question
 *  lines sends only the words). */
function askLine(question: NonNullable<BotItem['question']>): string {
  const first = question.decisions?.[0]
  return first
    ? botItemQuestionLine(first.question)
    : (question.gist ?? botItemQuestionLine(question.text))
}

export function NeedsYouInboxRow({
  ref,
  id,
  item,
  bot,
  now,
  selected,
  offline,
  snoozing,
  snoozeOpen,
  onSnoozeOpen,
  onSnoozeClosed,
  onSelect,
  onDone
}: {
  ref: (node: HTMLDivElement | null) => void
  id: string
  item: BotItem
  bot: Bot
  now: number
  selected: boolean
  offline: boolean
  snoozing: BotItemSnoozing
  snoozeOpen: boolean
  onSnoozeOpen: (open: boolean) => void
  onSnoozeClosed: () => void
  onSelect: () => void
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const asks = item.question ? askLine(item.question) : ''
  const more = (item.question?.decisions?.length ?? 0) > 1
  const doneLabel = t('bots.items.row.done', 'Done')
  const snoozeLabel = t('bots.items.snooze.menu', 'Snooze')
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      data-current={selected ? 'true' : undefined}
      className={cn(
        'group/row relative flex min-w-0 shrink-0 cursor-pointer flex-col gap-0.5 rounded-sm px-2.5 py-2 hover:bg-accent',
        selected && 'bg-accent'
      )}
      onClick={onSelect}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <BotAvatar bot={bot} className="size-4 shrink-0 rounded-full text-[9px]" />
        <span className="min-w-0 truncate">{bot.name}</span>
        <span className="shrink-0 tabular-nums">#{item.number}</span>
        <span className="ml-auto shrink-0 tabular-nums group-hover/row:invisible group-has-[[data-state=open]]/row:invisible">
          {formatShortTimeAgo(botItemActivityAt(item, now), now)}
        </span>
      </div>
      <div className="min-w-0 truncate text-[13px] leading-5 text-foreground">{item.title}</div>
      {asks ? (
        <div className="line-clamp-2 text-xs leading-4 text-muted-foreground">
          {asks}
          {more ? (
            <span className="ml-1 whitespace-nowrap">
              {t('bots.needsYouInbox.moreQuestions', '+{{more}}', {
                more: (item.question?.decisions?.length ?? 1) - 1
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      <span className="absolute top-1 right-1 hidden gap-0.5 group-hover/row:flex has-[[data-state=open]]:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost-on-accent"
              size="icon-xs"
              tabIndex={-1}
              disabled={offline}
              aria-label={doneLabel}
              onClick={(event) => {
                event.stopPropagation()
                onDone()
              }}
            >
              <Check className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {doneLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu open={snoozeOpen} onOpenChange={onSnoozeOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost-on-accent"
              size="icon-xs"
              tabIndex={-1}
              disabled={offline}
              aria-label={snoozeLabel}
              onClick={(event) => event.stopPropagation()}
            >
              <Clock className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(event) => event.stopPropagation()}
            // Back to the list, not the row's hover trigger, so its keys keep working.
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              onSnoozeClosed()
            }}
          >
            <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} inSubmenu={false} />
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  )
}
