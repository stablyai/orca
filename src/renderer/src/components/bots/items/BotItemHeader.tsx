// The open item's top: number and title (and snooze). It stays at the top of the item's scroll the whole
// time (CSS sticky, nothing read on scroll); its status menu sits at the right of the back row above it.
import { createPortal } from 'react-dom'
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
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from './BotItemSnooze'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'
import { botItemPickName, botItemStatusName } from './bot-item-status-name'
import { botHostTakes } from '../bot-host-capability'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'

export function BotItemHeader({
  bot,
  item,
  deleted,
  onStatus,
  snoozing,
  statusSlot,
  reply
}: {
  bot: Bot
  item: BotItem
  /** Gone from the host: its status can no longer change. */
  deleted: boolean
  onStatus: (to: BotItemStatus) => void
  snoozing: BotItemSnoozing
  /** The back row's right end: the status menu goes there; without one it gets a row of its own. */
  statusSlot?: HTMLElement | null
  reply?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
  const snoozed = isBotItemSnoozed(item, now)
  const status = (
    <>
      {reply}
      <StatusMenu
        item={item}
        waiting={botHostTakes(bot, BOTS_ITEM_WAITING_CAPABILITY)}
        disabled={deleted}
        onStatus={onStatus}
        snoozing={snoozing}
      />
    </>
  )
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 bg-sidebar px-3.5 pt-1 pb-3">
      {statusSlot ? (
        createPortal(status, statusSlot)
      ) : statusSlot === undefined ? (
        <div className="-mr-2 flex justify-end">{status}</div>
      ) : null}
      <h2
        title={item.title}
        className="line-clamp-2 break-words text-[15px] font-semibold leading-[21px] text-foreground [@media(max-height:620px)]:line-clamp-1"
      >
        <span className="font-normal tabular-nums text-muted-foreground">
          {formatBotItemNumber(item.number)}
        </span>{' '}
        {item.title}
      </h2>
      {snoozed && item.snoozedUntil !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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

/** Keyboard focus and scroll-into-view stop below the header rather than under it. Measured when the
 *  header changes size, never on scroll. */
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
        <Button variant="ghost" size="xs" className="shrink-0" disabled={disabled}>
          <BotItemStatusIcon status={item.status} live={isBotItemLive(item)} />
          {botItemStatusName(item.status, t)}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
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
