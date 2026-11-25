// The open item's top, two rows: number and title, then its status, its links and (while its question is
// off screen) Reply; a snooze adds its line. It stays at the top of the item's scroll the whole time (CSS
// sticky, nothing read on scroll), so the links are in reach while the owner reads the activity below.
import { useEffect, useEffectEvent, useRef } from 'react'
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
  snoozing,
  scrollRef,
  reply,
  onHeight
}: {
  bot: Bot
  item: BotItem
  chatTitle: string
  /** Gone from the host: its status can no longer change. */
  deleted: boolean
  onStatus: (to: BotItemStatus) => void
  snoozing: BotItemSnoozing
  /** The item's scroller: a control Tab reaches is scrolled clear of this header, not under it. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** At the status row's end: the way to the question when it is off screen. */
  reply?: React.ReactNode
  /** The header's height, each time it changes. */
  onHeight?: (height: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const header = useRef<HTMLDivElement | null>(null)
  useScrollPaddingBelow(scrollRef, header, onHeight)
  const now = useNow(60_000)
  const snoozed = isBotItemSnoozed(item, now)
  return (
    <div
      ref={header}
      className="sticky top-0 z-10 flex shrink-0 flex-col gap-1.5 border-b border-border/60 bg-sidebar px-3.5 pt-1 pb-2.5"
    >
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
        {reply ? <div className="ml-auto flex shrink-0 pl-1">{reply}</div> : null}
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

/** Keyboard focus and scroll-into-view stop below the header rather than under it. Measured when the
 *  header changes size, never on scroll. */
function useScrollPaddingBelow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  header: React.RefObject<HTMLDivElement | null>,
  onHeight: ((height: number) => void) | undefined
): void {
  const report = useEffectEvent((height: number) => onHeight?.(height))
  useEffect(() => {
    const root = scrollRef.current
    const node = header.current
    if (!root || !node || typeof ResizeObserver === 'undefined') {
      return
    }
    const previous = root.style.scrollPaddingTop
    const measure = (): void => {
      const height = node.getBoundingClientRect().height
      root.style.scrollPaddingTop = `${height}px`
      report(height)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => {
      observer.disconnect()
      root.style.scrollPaddingTop = previous
    }
  }, [scrollRef, header])
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
