// A bot's items in groups: Needs you (led by Orca's asks) and In progress open; Planned, Snoozed, Stale
// and Closed folded. Each shows five rows, then Show N more. Checked rows get the floating pill; Stale's header
// cancels them all. Asks have no checkbox, so selection and ranges never reach them.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
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
import { BotPanelSectionHeader } from '../BotPanelSection'
import { useBotPanelFold, type BotPanelFoldId } from '../use-bot-panel-fold'
import { BotNeedsYouSection, type BotNeedsYouAsks } from '../BotNeedsYouSection'
import { botNeedsYouCount } from '../../../../../shared/bots/bot-now'
import { BotItemRow, type BotItemRowAction } from './BotItemRow'
import { useBotItemStatusNotes } from './BotItemStatusNoteDialog'
import { BotItemSelectionPill } from './BotItemSelectionPill'
import { botItemGroupName } from '../../../../../shared/bots/bot-item-status-name'
import { botItemsByBot, setBotItemsStatus } from './use-bot-items'
import { useBotItemSnoozing, type BotItemSnoozing } from './BotItemSnooze'
import { BotItemRowsWindow } from './BotItemRowsWindow'
import { useBotItemGroupBack } from './use-bot-item-group-back'
import {
  BOT_ITEMS_SCROLLER_ATTR,
  useBotItemsViewport,
  type BotItemsViewport
} from './bot-items-viewport'
import { listOwner, type BotItemsListMembers, type ListOwner } from './bot-items-list-owner'

export type { BotItemsListMembers }

const foldId = (id: BotItemGroupId): BotPanelFoldId => `items-${id}`

export type BotItemsListProps = {
  /** Status above the list, whose presence changes every windowed group’s offset. */
  allClear?: React.JSX.Element | null
  /** The bot whose items these are, or a group's members. */
  bot: Bot | BotItemsListMembers
  groups: BotItemGroups
  /** One bot's seen mark; a group's list reads its members'. */
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
  /** The panel's scroller, which a long group windows its rows against. */
  scroller?: React.RefObject<HTMLDivElement | null>
}

const NO_ASKS: BotNeedsYouAsks = { needs: [], stoppedForSignIn: [], itemOf: () => null }

export function BotItemsList(props: BotItemsListProps): React.JSX.Element {
  const { groups, onOpen, scroller: panelScroller } = props
  const owner = listOwner(props.bot, props.seenEventId)
  const { botOf } = owner
  const t = useTranslate()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const ordered = useMemo(() => BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id]), [groups])
  // Every row's number column fits the widest number, so titles start in one column at #100 too.
  const numberColumn = useMemo(
    (): React.CSSProperties & { '--bot-item-number-chars': number } => ({
      '--bot-item-number-chars': ordered.reduce(
        (widest, item) => Math.max(widest, formatBotItemNumber(item.number).length),
        0
      )
    }),
    [ordered]
  )
  const selectedItems = useMemo(
    () => ordered.filter((item) => selected.has(item.uid)),
    [ordered, selected]
  )
  const snoozing = useBotItemSnoozing(botOf, () => setSelected(new Set()))
  // The scroller and this list, attached as the list mounts (before it's painted): the scroller by its
  // mark, since its own ref is set only after this list's effects. Nothing renders again for it.
  const listRef = useRef<HTMLDivElement | null>(null)
  const viewport = useBotItemsViewport()
  useLayoutEffect(() => {
    const list = listRef.current
    viewport.attach(
      panelScroller?.current ?? list?.closest<HTMLElement>(`[${BOT_ITEMS_SCROLLER_ATTR}]`) ?? null,
      list
    )
    viewport.flush()
    return () => viewport.attach(null, null)
  }, [viewport, panelScroller])

  const select = useLatestHandler((item: BotItem, on: boolean, range: boolean): void => {
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
  })

  const move = async (items: readonly BotItem[], to: BotItemStatus, reason?: string) => {
    try {
      await Promise.all(
        botItemsByBot(items, botOf).map(([ref, mine]) =>
          setBotItemsStatus(
            ref,
            mine.map((item) => item.uid),
            to,
            reason
          )
        )
      )
      setSelected(new Set())
    } catch (error) {
      toast.error(botErrorMessage(error))
    }
  }

  const notes = useBotItemStatusNotes((items, to, note) => void move(items, to, note))

  const act = useLatestHandler((item: BotItem, action: BotItemRowAction): void => {
    if (action.kind === 'open') {
      onOpen(item)
    } else if (action.kind === 'done') {
      void move([item], 'done')
    } else {
      void move([item], 'canceled')
    }
  })

  const staleReason =
    props.staleDays === null
      ? ''
      : t('bots.items.stale.reason', 'No activity for {{count}} days.', { count: props.staleDays })
  const list = (
    <div
      ref={listRef}
      className="flex flex-col gap-2"
      style={numberColumn}
      onKeyDown={(event) => event.key === 'Escape' && setSelected(new Set())}
    >
      {BOT_ITEM_GROUP_IDS.map((id) => (
        <BotItemGroup
          key={id}
          id={id}
          {...props}
          owner={owner}
          selected={selected}
          onSelect={select}
          onAction={act}
          snoozing={snoozing}
          viewport={viewport}
          onCancelAll={id === 'stale' ? () => move(groups.stale, 'canceled', staleReason) : null}
          staleReason={staleReason}
        />
      ))}
      {selectedItems.length > 0 ? (
        <BotItemSelectionPill
          items={selectedItems}
          snoozing={snoozing}
          botOf={botOf}
          onMove={(to) => notes.move(selectedItems, to)}
          onClear={() => setSelected(new Set())}
        />
      ) : null}
      {notes.dialog}
      {snoozing.dialog}
    </div>
  )
  return (
    <>
      {props.allClear}
      {list}
    </>
  )
}

function BotItemGroup({
  id,
  allClear,
  owner,
  groups,
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
  focusFallback,
  viewport
}: BotItemsListProps & {
  id: BotItemGroupId
  viewport: BotItemsViewport
  owner: ListOwner
  selected: ReadonlySet<string>
  onSelect: (item: BotItem, on: boolean, range: boolean) => void
  onAction: (item: BotItem, action: BotItemRowAction) => void
  snoozing: BotItemSnoozing
  onCancelAll: (() => Promise<void>) | null
  staleReason: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const items = groups[id]
  const fold = useBotPanelFold(owner.foldKey, foldId(id))
  const foldedByDefault = BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT.has(id)
  const open = foldedByDefault ? !fold.open : fold.open
  const setOpen = (next: boolean): void => fold.onOpenChange(foldedByDefault ? !next : next)
  // Back's row, taken as the list mounts: past the five shown rows, the group shows down to it.
  const [focusIndex] = useState(() =>
    focusUid ? items.findIndex((item) => item.uid === focusUid) : -1
  )
  const [shown, setShown] = useState(Math.max(BOT_ITEM_GROUP_ROWS, focusIndex + 1))
  // A group whose row count changes (folding, Show more, rows coming or going while open, appearing or
  // emptying) moves the groups below, even with the list's height unchanged (rows aging from one group
  // into another): they measure again before it's painted. A folded group's count changes nothing;
  // other height changes reach them through the list's resize, a frame later.
  const drawnRows = open ? (id === 'needs_you' ? items.length : Math.min(shown, items.length)) : -1
  const present = items.length > 0 || (id === 'needs_you' && owner.outside.count > 0)
  const hasAllClear = allClear != null
  useLayoutEffect(() => viewport.flush(), [drawnRows, present, hasAllClear, viewport])
  // Only an open window draws rows: a folded group, or Needs you, copies none.
  const shownItems = useMemo(
    () => (open && id !== 'needs_you' ? items.slice(0, shown) : []),
    [open, id, items, shown]
  )
  const section = useRef<HTMLElement | null>(null)
  const unfold = useLatestHandler(() => setOpen(true))
  const { backItem, backFocused, backRowRef } = useBotItemGroupBack({
    items,
    focusUid,
    focusIndex,
    shown,
    open,
    unfold
  })
  const [confirming, setConfirming] = useState(false)
  const [reading, setReading] = useState(false)
  const needsYou = id === 'needs_you'
  const total = id === 'closed' ? Math.max(closedTotal, items.length) : items.length
  // Needs you counts the rows it lists, asks first; runs a sign-in stopped are context, not counted.
  const count = needsYou ? botNeedsYouCount(asks.needs.length, items.length) : total
  // A group's Needs you also says what its bots need elsewhere, which its count leaves out.
  const outside = needsYou ? owner.outside.count : 0
  if (count === 0 && outside === 0) {
    return null
  }
  const row = (item: BotItem, tabbable?: boolean): React.JSX.Element => (
    <BotItemRow
      key={item.uid}
      item={item}
      stale={id === 'stale'}
      snoozed={id === 'snoozed'}
      snoozing={snoozing}
      unseen={isBotItemUnseen(item, owner.seenOf(item))}
      selected={selected.has(item.uid)}
      selecting={selected.size > 0}
      now={now}
      onSelect={onSelect}
      onAction={onAction}
      face={owner.faces ? owner.botOf(item) : null}
      place={owner.placeOf(item)}
      // In a window, the window's slot is the list item and the Tab stop is chosen there.
      tabbable={tabbable}
      listItem={tabbable === undefined}
    />
  )
  const fresh =
    id === 'closed' ? items.filter((item) => isBotItemUnseen(item, owner.seenOf(item))) : []
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
      <BotPanelSectionHeader
        title={botItemGroupName(id, t)}
        fold={{ open, onOpenChange: setOpen }}
        // Open, the rows count themselves; folded, nothing else says what it hides.
        summary={
          open ? null : (
            <>
              {count}
              {fresh.length > 0 ? (
                <span className="text-foreground">
                  {' · '}
                  {t('bots.items.group.new', '{{count}} new', { count: fresh.length })}
                </span>
              ) : null}
            </>
          )
        }
        actions={
          onCancelAll && items.length > 0 ? (
            <Button variant="ghost" size="xs" className="h-6" onClick={() => setConfirming(true)}>
              {t('bots.items.stale.cancelAll', 'Cancel all')}
            </Button>
          ) : null
        }
      />
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
        <div className="flex flex-col gap-0.5">
          <BotNeedsYouSection
            backRow={backItem ? { uid: backItem.uid, ref: backRowRef } : null}
            bot={owner.needBot}
            asks={asks}
            items={items}
            renderItem={row}
            revealUid={focusUid}
            offline={offline}
            focusFallback={focusFallback}
          />
        </div>
      ) : open ? (
        <>
          <BotItemRowsWindow
            items={shownItems}
            placed={owner.placed ?? null}
            viewport={viewport}
            label={botItemGroupName(id, t)}
            renderRow={row}
            backUid={backItem?.uid ?? null}
            onBackFocused={backFocused}
            disabled={offline}
          />
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
      {open && outside > 0 ? (
        <p className="py-0.5 pl-8 pr-2 text-xs text-muted-foreground">
          {owner.outside.of === 'room'
            ? t('bots.groups.items.outsideRoom', '{{count}} more outside this room', {
                count: outside,
                defaultValue_one: '{{count}} more outside this room'
              })
            : owner.outside.of === 'thread'
              ? t('bots.groups.items.outsideThread', '{{count}} more outside this thread', {
                  count: outside,
                  defaultValue_one: '{{count}} more outside this thread'
                })
              : t('bots.groups.items.outside', '{{count}} more outside this group', {
                  count: outside,
                  defaultValue_one: '{{count}} more outside this group'
                })}
        </p>
      ) : null}
    </section>
  )
}
