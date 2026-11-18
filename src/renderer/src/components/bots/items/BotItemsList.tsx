// A bot's items in groups: Needs you (led by Orca's asks), In progress and Closed open; Planned, Snoozed
// and Stale folded. Each shows five rows, then Show N more. Checked rows get the floating pill; Stale's header
// cancels them all. Asks have no checkbox, so selection and ranges never reach them.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { Bot } from '../../../../../shared/bot-types'
import {
  formatBotItemNumber,
  type BotItem,
  type BotItemStatus
} from '../../../../../shared/bots/bot-items'
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_GROUP_ROWS,
  BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT,
  isBotItemUnseen,
  type BotItemGroupId,
  type BotItemGroups
} from '../../../../../shared/bots/bot-item-groups'
import { botErrorMessage } from '../bot-presentation'
import { useBotPanelFold, type BotPanelFoldId } from '../use-bot-panel-fold'
import { BotNeedsYouSection, type BotNeedsYouAsks } from '../BotNeedsYouSection'
import { botNeedsYouCount } from '../../../../../shared/bots/bot-now'
import { BotItemRow, type BotItemRowAction } from './BotItemRow'
import { BotItemCancelDialog } from './BotItemCancelDialog'
import { BotItemSelectionPill } from './BotItemSelectionPill'
import { botItemGroupName } from '../../../../../shared/bots/bot-item-status-name'
import { setBotItemsStatus } from './use-bot-items'
import { useBotItemSnoozing, type BotItemSnoozing } from './BotItemSnooze'

// Closed's old flag meant "opened" under its old folded default; its own id keeps that from folding it.
const foldId = (id: BotItemGroupId): BotPanelFoldId =>
  id === 'closed' ? 'items-closed-folded' : `items-${id}`

export type BotItemsListProps = {
  bot: Bot
  groups: BotItemGroups
  seenEventId: string
  /** Closed items on the host, past what is loaded; Show more reads them. */
  closedTotal: number
  onMoreClosed: (() => Promise<unknown>) | null
  staleDays: number | null
  now: number
  /** The row to focus as the list shows (Back from its item): unfolded, shown and scrolled to. */
  focusUid?: string | null
  onOpen: (item: BotItem) => void
  /** Orca's asks, leading Needs you; they show whatever the item read says. */
  asks?: BotNeedsYouAsks
  /** The host is offline: Needs you shows every row, its footer being off with the panel. */
  offline?: boolean
  /** Takes focus when a focused Needs you row leaves and no other row has a control. */
  focusFallback?: React.RefObject<HTMLElement | null>
}

const NO_ASKS: BotNeedsYouAsks = { needs: [], stoppedForSignIn: [], itemOf: () => null }

export function BotItemsList(props: BotItemsListProps): React.JSX.Element {
  const { bot, groups, onOpen } = props
  const t = useTranslate()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [canceling, setCanceling] = useState<readonly BotItem[] | null>(null)
  const ordered = useMemo(() => BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id]), [groups])
  // Every row's number column fits the widest number, so titles start in one column at #100 too.
  const numberColumn: React.CSSProperties & { '--bot-item-number-chars': number } = {
    '--bot-item-number-chars': ordered.reduce(
      (widest, item) => Math.max(widest, formatBotItemNumber(item.number).length),
      0
    )
  }
  const selectedItems = ordered.filter((item) => selected.has(item.uid))
  const snoozing = useBotItemSnoozing(bot, () => setSelected(new Set()))

  const select = (item: BotItem, on: boolean, range: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      const from = anchor ? ordered.findIndex((entry) => entry.uid === anchor) : -1
      const to = ordered.findIndex((entry) => entry.uid === item.uid)
      const uids =
        range && from >= 0
          ? ordered.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry.uid)
          : [item.uid]
      uids.forEach((uid) => (on ? next.add(uid) : next.delete(uid)))
      return next
    })
    setAnchor(item.uid)
  }

  const move = async (items: readonly BotItem[], to: BotItemStatus, reason?: string) => {
    try {
      await setBotItemsStatus(
        bot,
        items.map((item) => item.uid),
        to,
        reason
      )
      setSelected(new Set())
    } catch (error) {
      toast.error(botErrorMessage(error))
    }
  }

  const act = (item: BotItem, action: BotItemRowAction): void => {
    if (action.kind === 'open') {
      onOpen(item)
    } else if (action.kind === 'done') {
      void move([item], 'done')
    } else {
      setCanceling([item])
    }
  }

  const staleReason =
    props.staleDays === null
      ? ''
      : t('bots.items.stale.reason', 'No activity for {{count}} days.', { count: props.staleDays })
  return (
    <div
      role="list"
      className="flex flex-col gap-2"
      style={numberColumn}
      onKeyDown={(event) => event.key === 'Escape' && setSelected(new Set())}
    >
      {BOT_ITEM_GROUP_IDS.map((id) => (
        <BotItemGroup
          key={id}
          id={id}
          {...props}
          selected={selected}
          onSelect={select}
          onAction={act}
          snoozing={snoozing}
          onCancelAll={id === 'stale' ? () => move(groups.stale, 'canceled', staleReason) : null}
          staleReason={staleReason}
        />
      ))}
      {selectedItems.length > 0 ? (
        <BotItemSelectionPill
          items={selectedItems}
          snoozing={snoozing}
          onMove={(to) =>
            to === 'canceled' ? setCanceling(selectedItems) : void move(selectedItems, to)
          }
          onClear={() => setSelected(new Set())}
        />
      ) : null}
      <BotItemCancelDialog
        items={canceling}
        onCancel={(reason) => {
          const items = canceling ?? []
          setCanceling(null)
          void move(items, 'canceled', reason)
        }}
        onClose={() => setCanceling(null)}
      />
      {snoozing.dialog}
    </div>
  )
}

function BotItemGroup({
  id,
  bot,
  groups,
  seenEventId,
  closedTotal,
  onMoreClosed,
  now,
  focusUid,
  selected,
  onSelect,
  onAction,
  snoozing,
  onCancelAll,
  staleReason,
  asks = NO_ASKS,
  offline = false,
  focusFallback
}: BotItemsListProps & {
  id: BotItemGroupId
  selected: ReadonlySet<string>
  onSelect: (item: BotItem, on: boolean, range: boolean) => void
  onAction: (item: BotItem, action: BotItemRowAction) => void
  snoozing: BotItemSnoozing
  onCancelAll: (() => Promise<void>) | null
  staleReason: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const items = groups[id]
  const fold = useBotPanelFold(bot.id, foldId(id))
  const foldedByDefault = BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT.has(id)
  const open = foldedByDefault ? !fold.open : fold.open
  const setOpen = (next: boolean): void => fold.onOpenChange(foldedByDefault ? !next : next)
  // Back's row, taken as the list mounts: past the five shown rows, the group shows down to it.
  const [focusIndex] = useState(() =>
    focusUid ? items.findIndex((item) => item.uid === focusUid) : -1
  )
  const [shown, setShown] = useState(Math.max(BOT_ITEM_GROUP_ROWS, focusIndex + 1))
  const section = useRef<HTMLElement | null>(null)
  const focusing = useRef(focusIndex >= 0)
  const unfold = useLatestHandler(() => setOpen(true))
  useEffect(() => {
    if (!focusing.current) {
      return
    }
    if (!open) {
      unfold()
      return
    }
    focusing.current = false
    const row = section.current?.querySelector<HTMLElement>(
      `[data-bot-item="${items[focusIndex]?.number}"]`
    )
    // Back is a command, not navigation: Esc would otherwise draw Chromium's keyboard ring here.
    row
      ?.querySelector<HTMLElement>('[data-bot-item-open]')
      ?.focus({ preventScroll: true, focusVisible: false })
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, unfold, items, focusIndex])
  const [confirming, setConfirming] = useState(false)
  const [reading, setReading] = useState(false)
  const needsYou = id === 'needs_you'
  const total = id === 'closed' ? Math.max(closedTotal, items.length) : items.length
  // Needs you counts the rows it lists, asks first; runs a sign-in stopped are context, not counted.
  const count = needsYou ? botNeedsYouCount(asks.needs.length, items.length) : total
  if (count === 0) {
    return null
  }
  const row = (item: BotItem): React.JSX.Element => (
    <BotItemRow
      key={item.uid}
      item={item}
      stale={id === 'stale'}
      snoozed={id === 'snoozed'}
      snoozing={snoozing}
      unseen={isBotItemUnseen(item, seenEventId)}
      selected={selected.has(item.uid)}
      selecting={selected.size > 0}
      now={now}
      onSelect={(on, range) => onSelect(item, on, range)}
      onAction={(action) => onAction(item, action)}
    />
  )
  const fresh = id === 'closed' ? items.filter((item) => isBotItemUnseen(item, seenEventId)) : []
  const more = total - Math.min(shown, items.length)
  const showMore = async (): Promise<void> => {
    if (shown + BOT_ITEM_GROUP_ROWS > items.length && onMoreClosed && id === 'closed') {
      setReading(true)
      await onMoreClosed().catch((error: unknown) => toast.error(botErrorMessage(error)))
      setReading(false)
    }
    setShown(shown + Math.max(BOT_ITEM_GROUP_ROWS, items.length))
  }
  return (
    <section ref={section} className="flex flex-col gap-0.5">
      <div className="flex min-h-6 items-center gap-2 pr-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          {botItemGroupName(id, t)}
          <span className="tabular-nums">{count}</span>
        </button>
        {fresh.length > 0 && !open ? (
          <span className="ml-auto flex items-center gap-1 text-2xs text-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
            {t('bots.items.group.new', '{{count}} new', { count: fresh.length })}
          </span>
        ) : null}
        {onCancelAll && items.length > 0 ? (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setConfirming(true)}>
            {t('bots.items.stale.cancelAll', 'Cancel all')}
          </Button>
        ) : null}
      </div>
      {confirming && onCancelAll ? (
        <div className="mx-1 my-1 flex flex-col gap-2 rounded-md border border-border bg-popover p-2.5 text-xs">
          <span className="font-medium text-foreground">
            {t('bots.items.stale.confirm', 'Cancel {{count}} stale items?', {
              count: items.length,
              defaultValue_one: 'Cancel {{count}} stale item?'
            })}
          </span>
          <span className="text-muted-foreground">
            {t(
              'bots.items.stale.confirmWhy',
              'Reason sent to the bot: “{{reason}}” Nothing is deleted.',
              {
                reason: staleReason
              }
            )}
          </span>
          <span className="flex justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
              {t('bots.items.cancel.keep', 'Keep')}
            </Button>
            <Button
              size="xs"
              onClick={() => {
                setConfirming(false)
                void onCancelAll()
              }}
            >
              {t('bots.items.cancel.confirmMany', 'Cancel {{count}}', { count: items.length })}
            </Button>
          </span>
        </div>
      ) : null}
      {open && needsYou ? (
        <BotNeedsYouSection
          bot={bot}
          asks={asks}
          items={items}
          renderItem={row}
          revealUid={focusUid}
          offline={offline}
          focusFallback={focusFallback}
        />
      ) : open ? (
        <>
          {items.slice(0, shown).map(row)}
          {more > 0 ? (
            <button
              type="button"
              disabled={reading}
              className="self-start py-0.5 pl-8 pr-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void showMore()}
            >
              {t('bots.items.group.showMore', 'Show {{count}} more', { count: more })}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
