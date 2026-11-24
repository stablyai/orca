// The open item's top, two rows: number and title, then its status, its links and (while its question is
// off screen) Reply; a snooze adds its line. It sits above the Activity's scroller, so the links stay in
// reach while the owner reads the activity below.
import { AlarmClock, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botItemPickerStatuses,
  formatBotItemNumber,
  isBotItemLive,
  isBotItemSnoozed,
  isOpenBotItemStatus,
  type BotItem,
  type BotItemStatus
} from '../../../../../shared/bots/bot-items'
import { BotItemLinkChips } from './BotItemLinkChips'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from './BotItemSnooze'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'
import { botItemPickName, botItemStatusName } from './bot-item-status-name'
import { botHostTakes } from '../bot-host-capability'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'

export function BotItemHeader({
  bot,
  item,
  chatTitle,
  deleted,
  onStatus,
  snoozing
}: {
  bot: Bot
  item: BotItem
  chatTitle: string
  /** Gone from the host: its status can no longer change. */
  deleted: boolean
  onStatus: (to: BotItemStatus) => void
  snoozing: BotItemSnoozing
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
  const snoozed = isBotItemSnoozed(item, now)
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3.5 pt-1 pb-2.5">
      <h2
        title={item.title}
        className="line-clamp-2 break-words text-[15px] font-semibold leading-[21px] text-foreground [@media(max-height:620px)]:line-clamp-1"
      >
        <span className="font-normal tabular-nums text-muted-foreground">
          {formatBotItemNumber(item.number)}
        </span>{' '}
        {item.title}
      </h2>
      <div className="flex min-w-0 items-center gap-1">
        <StatusMenu
          item={item}
          waiting={botHostTakes(bot, BOTS_ITEM_WAITING_CAPABILITY)}
          disabled={deleted}
          onStatus={onStatus}
          snoozing={snoozing}
        />
        <BotItemLinkChips bot={bot} links={item.links} chat={chatTitle} />
      </div>
      {snoozed && item.snoozedUntil !== null ? (
        <div className="-mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <AlarmClock className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            {t('bots.items.snooze.until', 'Snoozed until {{when}}', {
              when: formatBotItemSnoozeTime(item.snoozedUntil, now)
            })}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto h-[22px]"
            disabled={deleted}
            onClick={() => snoozing.snooze([item], null)}
          >
            {t('bots.items.snooze.unsnooze', 'Unsnooze')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function StatusMenu({
  item,
  waiting,
  disabled,
  onStatus,
  snoozing
}: {
  item: BotItem
  /** The item's host has Waiting. */
  waiting: boolean
  disabled: boolean
  onStatus: (to: BotItemStatus) => void
  snoozing: BotItemSnoozing
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-1.5 min-w-0 shrink" disabled={disabled}>
          <BotItemStatusIcon status={item.status} live={isBotItemLive(item)} />
          {/* Cut before the row's other controls are, in the narrowest pane. */}
          <span className="min-w-0 truncate">{botItemStatusName(item.status, t)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {botItemPickerStatuses(waiting).map((status) => (
          <DropdownMenuItem
            key={status}
            // Waiting again edits what it waits on.
            disabled={status === item.status && status !== 'waiting'}
            onSelect={() => onStatus(status)}
          >
            <span className="flex w-4 justify-center">
              <BotItemStatusIcon status={status} />
            </span>
            <span className="flex-1">{botItemPickName(status, t)}</span>
            {status === item.status ? <Check className="size-3" /> : null}
          </DropdownMenuItem>
        ))}
        {isOpenBotItemStatus(item.status) ? (
          <>
            <DropdownMenuSeparator />
            <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
