// The open item's top: number and title, when and where it was made, its status (and snooze) and its links. It
// stays at the top of the item's scroll the whole time (CSS sticky, nothing read on scroll), so the
// links are in view while the owner reads the activity or answers a question below.
import { useEffect, useRef } from 'react'
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
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { Bot } from '../../../../../shared/bot-types'
import {
  BOT_ITEM_STATUSES,
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
import { botItemStatusName } from './bot-item-status-name'

const WHEN = { weekday: 'short', hour: 'numeric', minute: '2-digit' } as const

export function BotItemHeader({
  bot,
  item,
  chatTitle,
  deleted,
  onStatus,
  snoozing,
  scrollRef
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
}): React.JSX.Element {
  const t = useTranslate()
  const header = useRef<HTMLDivElement | null>(null)
  useScrollPaddingBelow(scrollRef, header)
  const now = useNow(60_000)
  const snoozed = isBotItemSnoozed(item, now)
  return (
    <div
      ref={header}
      className="sticky top-0 z-10 flex shrink-0 flex-col gap-1.5 border-b border-border/60 bg-sidebar px-3.5 pt-1 pb-2"
    >
      <div>
        <h2
          title={item.title}
          className="line-clamp-2 break-words text-[15px] font-semibold leading-[21px] text-foreground [@media(max-height:620px)]:line-clamp-1"
        >
          <span className="font-normal tabular-nums text-muted-foreground">
            {formatBotItemNumber(item.number)}
          </span>{' '}
          {item.title}
        </h2>
        <div className="flex min-w-0 items-center gap-2">
          <StatusMenu item={item} disabled={deleted} onStatus={onStatus} snoozing={snoozing} />
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {t('bots.items.view.sub', 'Item {{number}} · {{chat}} · {{when}}', {
              number: item.number,
              chat: chatTitle,
              when: uiDateTimeFormat(WHEN).format(item.createdAt)
            })}
          </p>
        </div>
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
      <BotItemLinkChips bot={bot} links={item.links} chat={chatTitle} />
    </div>
  )
}

/** Keyboard focus and scroll-into-view stop below the header rather than under it. Measured when the
 *  header changes size, never on scroll. */
function useScrollPaddingBelow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  header: React.RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const root = scrollRef.current
    const node = header.current
    if (!root || !node || typeof ResizeObserver === 'undefined') {
      return
    }
    const previous = root.style.scrollPaddingTop
    const measure = (): void => {
      root.style.scrollPaddingTop = `${node.getBoundingClientRect().height}px`
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
  disabled,
  onStatus,
  snoozing
}: {
  item: BotItem
  disabled: boolean
  onStatus: (to: BotItemStatus) => void
  snoozing: BotItemSnoozing
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-1.5 shrink-0" disabled={disabled}>
          <BotItemStatusIcon status={item.status} live={isBotItemLive(item)} />
          {botItemStatusName(item.status, t)}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {BOT_ITEM_STATUSES.map((status) => (
          <DropdownMenuItem
            key={status}
            disabled={status === item.status}
            onSelect={() => onStatus(status)}
          >
            <span className="flex w-4 justify-center">
              <BotItemStatusIcon status={status} />
            </span>
            <span className="flex-1">
              {status === 'canceled'
                ? t('bots.items.menu.canceled', 'Canceled…')
                : botItemStatusName(status, t)}
            </span>
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
