// One inbox for every bot's Needs you items: the bots with their counts, the items (the longest waiting
// first, or by bot), and the selected item's own view, where it is answered as on its bot's Items tab.
// Keys on the list: J/K or arrows move, 1-9 pick the ask's quick reply, I replies in your own words,
// Enter opens the item on its bot, E marks it done, S snoozes it, G groups by bot. Esc in the item goes
// back to the list; Esc on the list closes the inbox.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListChecks, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { openBotHome } from '@/lib/bot-catalog'
import { useNow } from '@/lib/window-activity/use-now'
import { useAppStore } from '@/store'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import type { BotItemFilter, BotItemGroups } from '../../../../../shared/bots/bot-item-groups'
import {
  botNeedsYouInboxRows,
  type BotNeedsYouInboxOrder
} from '../../../../../shared/bots/bot-needs-you-inbox-order'
import { botErrorMessage } from '../bot-presentation'
import { useBotGroupItems } from '../use-bot-group-items'
import { BotItemPane } from '../items/BotItemPane'
import { BotItemsLoading } from '../items/BotItemsLoading'
import { BotItemsReadFailed } from '../items/BotItemsReadFailed'
import { openBotItem } from '../items/bot-item-open'
import { botItemsByBot, setBotItemsStatus } from '../items/use-bot-items'
import { useBotItemSnoozing } from '../items/BotItemSnooze'
import { useBotItemWalk, type BotItemWalkList } from '../items/use-bot-item-walk'
import { BotItemQuickAnswerContext, type BotItemQuickAnswer } from '../items/bot-item-quick-answer'
import { NeedsYouInboxRow } from './NeedsYouInboxRow'
import { NeedsYouInboxKeys } from './NeedsYouInboxKeys'
import { NeedsYouInboxBots } from './NeedsYouInboxBots'
import { escapeStaysInComposer, needsYouInboxKey } from './needs-you-inbox-keys'
import { useNeedsYouInboxMembers } from './use-needs-you-inbox-members'

const NEEDS_YOU_ONLY: BotItemFilter = { chatIds: null, botIds: null, needsYou: true }
const WALK_KEY = 'needs-you-inbox'
const NO_GROUPS: Omit<BotItemGroups, 'needs_you'> = {
  working: [],
  waiting: [],
  planned: [],
  snoozed: [],
  stale: [],
  closed: []
}

/** Mounted only while `activeModal` is 'bots-needs-you'. */
export default function BotsNeedsYouInboxDialog(): React.JSX.Element {
  const closeModal = useAppStore((state) => state.closeModal)
  return (
    <Dialog open onOpenChange={(next) => (next ? null : closeModal())}>
      <NeedsYouInbox onClose={closeModal} />
    </Dialog>
  )
}

function NeedsYouInbox({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useTranslate()
  const clock = useNow(60_000)
  const members = useNeedsYouInboxMembers()
  const merged = useBotGroupItems(members, NEEDS_YOU_ONLY, clock)
  const [botFilter, setBotFilter] = useState<string | null>(null)
  const [order, setOrder] = useState<BotNeedsYouInboxOrder>('oldest')
  const needsYou = merged.list.groups.needs_you
  const counts = useMemo(() => {
    const byBot = new Map<string, number>()
    for (const item of needsYou) {
      byBot.set(item.owner.botId, (byBot.get(item.owner.botId) ?? 0) + 1)
    }
    return byBot
  }, [needsYou])
  // A bot whose items were all answered drops its filter, so a later item of its own doesn't bring it back.
  // Only its own read counts: another host down or slow never keeps it.
  const filterRead =
    botFilter === null ? null : merged.reads.find((read) => read.bot.id === botFilter)
  if (
    filterRead &&
    filterRead.list.read !== null &&
    filterRead.seenEventId !== null &&
    !counts.has(filterRead.bot.id)
  ) {
    setBotFilter(null)
  }
  const shownFilter = botFilter !== null && counts.has(botFilter) ? botFilter : null
  const filteredBot = members.find((bot) => bot.id === shownFilter) ?? null
  const memberOrder = useMemo(() => members.map((bot) => bot.id), [members])
  const rows = useMemo(
    () =>
      botNeedsYouInboxRows(
        shownFilter === null
          ? needsYou
          : needsYou.filter((item) => item.owner.botId === shownFilter),
        order,
        memberOrder,
        clock
      ),
    [needsYou, shownFilter, order, memberOrder, clock]
  )
  const walkList = useMemo<BotItemWalkList>(
    () => ({
      groups: { ...NO_GROUPS, needs_you: rows },
      closedTotal: 0,
      loadMoreClosed: null,
      closedEnded: true
    }),
    [rows]
  )
  const walk = useBotItemWalk(walkList, WALK_KEY)
  const selectedUid = walk.uid
  const selectedIndex = selectedUid ? rows.findIndex((item) => item.uid === selectedUid) : -1
  const openBot = selectedUid ? merged.botOfUid(selectedUid) : null
  const offline = useBotHostOffline(openBot?.hostId ?? 'local') && openBot !== null
  const [quick, setQuick] = useState<BotItemQuickAnswer | null>(null)
  const selectedQuick = quick && quick.uid === selectedUid ? quick : null
  const listRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  // Where the selection last was, so an answered item's row gives way to the one after it.
  const lastIndex = useRef(0)
  useEffect(() => {
    if (selectedIndex >= 0) {
      lastIndex.current = selectedIndex
    }
  }, [selectedIndex])
  const { open: openWalk, close: closeWalk } = walk
  const select = useCallback(
    (uid: string | null) => {
      if (uid === null) {
        closeWalk()
      } else {
        openWalk(uid)
      }
    },
    [openWalk, closeWalk]
  )
  // Nothing selected, or the selected item left Needs you (answered, done, snoozed): the row in its place.
  // Rows already read count, so a bot whose host is unreachable never holds the others' selection.
  const settled = merged.ready || rows.length > 0
  useEffect(() => {
    if (!settled || (selectedUid !== null && selectedIndex !== -1)) {
      return
    }
    const next = rows[Math.min(lastIndex.current, rows.length - 1)]?.uid ?? null
    if (next !== selectedUid) {
      select(next)
    }
  }, [settled, selectedUid, selectedIndex, rows, select])
  useEffect(() => {
    if (selectedUid) {
      rowRefs.current.get(selectedUid)?.scrollIntoView({ block: 'nearest' })
    }
    // An answered item's view unmounts with the focus it held, or the next one's view takes it for
    // typing: the list takes it instead. A control in the pane (an arrow, the comment box) keeps it.
    // The dialog itself holds focus its removed control dropped.
    const active = document.activeElement
    if (
      !active ||
      active === document.body ||
      active.matches('[role=dialog], [data-bot-item-pane], [data-bot-item-focus-home]')
    ) {
      listRef.current?.focus({ preventScroll: true })
    }
  }, [selectedUid])
  // The pane's previous / next step through the rows as they are now: items arrive as reads land.
  const rowsKey = rows.map((item) => item.uid).join('\n')
  const walkedRows = useRef(rowsKey)
  const stillListed = selectedIndex !== -1
  useEffect(() => {
    if (walkedRows.current === rowsKey) {
      return
    }
    walkedRows.current = rowsKey
    if (stillListed && selectedUid) {
      openWalk(selectedUid)
    }
  }, [rowsKey, stillListed, selectedUid, openWalk])
  const botOf = useCallback((item: BotItem): Bot => merged.botOf(item), [merged])
  const snoozing = useBotItemSnoozing(botOf)
  const [snoozeUid, setSnoozeUid] = useState<string | null>(null)
  const selected = selectedIndex >= 0 ? rows[selectedIndex]! : null
  const focusList = (): void => listRef.current?.focus({ preventScroll: true })
  const step = (direction: 1 | -1): void => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, selectedIndex + direction))]
    if (next) {
      select(next.uid)
    }
  }
  const markDone = (item: BotItem): void => {
    void Promise.all(
      botItemsByBot([item], botOf).map(([ref, mine]) =>
        setBotItemsStatus(
          ref,
          mine.map((entry) => entry.uid),
          'done'
        )
      )
    ).catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  const openOnBot = (item: BotItem): void => {
    const bot = botOf(item)
    // A home not in the catalog yet can't open: the inbox stays, with the item still answerable here.
    if (openBotHome(bot)) {
      openBotItem(bot, item.uid)
      onClose()
    }
  }
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const key = needsYouInboxKey(event)
    // Moving and grouping work on any row; the rest act on the selected item while its host is up.
    const target = key && (key.kind === 'step' || key.kind === 'group' || (selected && !offline))
    if (!key || !target) {
      return
    }
    if (key.kind === 'step') {
      step(key.direction)
    } else if (key.kind === 'group') {
      setOrder((current) => (current === 'oldest' ? 'bot' : 'oldest'))
    } else if (key.kind === 'answer') {
      if (!selectedQuick?.answer(key.digit)) {
        return
      }
    } else if (key.kind === 'reply') {
      selectedQuick?.reply()
    } else if (selected) {
      if (key.kind === 'open') {
        openOnBot(selected)
      } else if (key.kind === 'done') {
        markDone(selected)
      } else {
        setSnoozeUid(selected.uid)
      }
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const empty = merged.ready && rows.length === 0
  const loading = !merged.ready && needsYou.length === 0
  return (
    <DialogContent
      surface="opaque-panel"
      showCloseButton={false}
      aria-describedby={undefined}
      className="@container grid h-[min(820px,calc(100vh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-none"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        focusList()
      }}
      onEscapeKeyDown={(event) => {
        // In the item, Esc never closes the inbox. As on the Items tab, a comment box with words or an
        // open suggestion list keeps it; anywhere else it goes back to the list. On the list it closes.
        const target = event.target
        if (!(target instanceof Element) || !paneRef.current?.contains(target)) {
          return
        }
        event.preventDefault()
        if (!isEditableTarget(target) || !escapeStaysInComposer(target)) {
          focusList()
        }
      }}
    >
      {merged.readers}
      <div className="flex items-center gap-2 border-b border-border py-3 pr-4 pl-5">
        <DialogTitle className="min-w-0 flex-1">
          {t('bots.needsYouInbox.title', 'Needs you')}
          {needsYou.length > 0 ? (
            <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
              {needsYou.length}
            </span>
          ) : null}
        </DialogTitle>
        {filteredBot ? (
          // The bot column folds away in a narrow window; this keeps a way back to every bot's items.
          <span className="@min-[60rem]:hidden">
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('bots.needsYouInbox.showAllBots', '{{bot}}, show all bots', {
                bot: filteredBot.name
              })}
              onClick={() => {
                setBotFilter(null)
                focusList()
              }}
            >
              {filteredBot.name}
              <X />
            </Button>
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={order === 'bot'}
          onClick={() => {
            setOrder(order === 'oldest' ? 'bot' : 'oldest')
            focusList()
          }}
        >
          {order === 'oldest'
            ? t('bots.needsYouInbox.order.oldest', 'Oldest first')
            : t('bots.needsYouInbox.order.bot', 'By bot')}
        </Button>
        <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('bots.needsYouInbox.close', 'Close')}
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('bots.needsYouInbox.closeTooltip', 'Close · Esc')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="grid min-h-0 grid-cols-[200px_minmax(300px,400px)_minmax(0,1fr)] @max-[60rem]:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <NeedsYouInboxBots
          bots={members}
          counts={counts}
          total={needsYou.length}
          shown={shownFilter}
          onShow={(botId) => {
            setBotFilter(botId)
            focusList()
          }}
        />
        <div
          ref={listRef}
          role="listbox"
          // A list in the page, not a popup: the item's comment box beside it may take focus.
          data-focus-behavior="page"
          tabIndex={0}
          aria-label={t('bots.needsYouInbox.list', 'Items that need you')}
          aria-activedescendant={selected ? `needs-you-${selected.uid}` : undefined}
          className="scrollbar-sleek flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={onListKeyDown}
        >
          {merged.failedRetry && !merged.ready ? (
            <BotItemsReadFailed onRetry={merged.failedRetry} />
          ) : null}
          {loading ? <BotItemsLoading /> : null}
          {empty ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground">
              <ListChecks className="size-5" />
              <b className="text-[13px] font-medium text-foreground">
                {t('bots.items.empty.needsYou', 'Nothing needs you.')}
              </b>
            </div>
          ) : null}
          {rows.map((item) => (
            <NeedsYouInboxRow
              key={item.uid}
              ref={(node) => {
                if (node) {
                  rowRefs.current.set(item.uid, node)
                } else {
                  rowRefs.current.delete(item.uid)
                }
              }}
              id={`needs-you-${item.uid}`}
              item={item}
              bot={botOf(item)}
              now={clock}
              selected={item.uid === selectedUid}
              offline={offline}
              snoozing={snoozing}
              snoozeOpen={snoozeUid === item.uid}
              onSnoozeOpen={(open) => setSnoozeUid(open ? item.uid : null)}
              onSnoozeClosed={focusList}
              onSelect={() => {
                select(item.uid)
                focusList()
              }}
              onDone={() => {
                markDone(item)
                focusList()
              }}
            />
          ))}
        </div>
        <div ref={paneRef} className="flex min-h-0 min-w-0 flex-col bg-sidebar">
          {selectedUid && openBot ? (
            <BotItemQuickAnswerContext value={setQuick}>
              <BotItemPane
                key={WALK_KEY}
                bot={openBot}
                uid={selectedUid}
                listed={selected ?? undefined}
                walk={walk}
                offline={offline}
                onBack={focusList}
                named
                backLabel={t('bots.needsYouInbox.back', 'List')}
                keepFocus
              />
            </BotItemQuickAnswerContext>
          ) : null}
        </div>
      </div>
      <NeedsYouInboxKeys />
      {snoozing.dialog}
    </DialogContent>
  )
}
