import { useEffect, useMemo, useRef, useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_NO_FILTER,
  filterBotItems,
  groupBotItems,
  type BotItemFilter
} from '../../../../../shared/bots/bot-item-groups'
import { botItemWalkReturnRow } from '../../../../../shared/bots/bot-item-walk'
import { BotItemPaneFrame, type BotItemPaneSlots } from './BotItemPane'
import { BotItemBody } from './BotItemView'
import { BotItemsList } from './BotItemsList'
import { useBotItemBackFocus } from './use-bot-item-back-focus'
import { useBotItemWalk } from './use-bot-item-walk'
import type { BotItemsClosedPage } from './use-bot-items-shown-list'

// A live walk: the real list, grouping and walk hook over seeded items, the pane on top when one is open.
// Needs you 3, In progress 4, Waiting 1, Snoozed 2, Stale 2, Closed 5 loaded of 40 (6 in the Design chat).
const WALK_NOW = Date.now()
const WALK_MIN = 60_000
const WALK_DAY = 24 * 60 * WALK_MIN
const WALK_STALE_DAYS = 5
const designChat = { id: 'chat-design', kind: 'chat', title: 'Design' } as const
const walkRows: [string, BotItem['status']][] = [
  ['Pick the release headline', 'needs_you'],
  ['Approve the staging cutover', 'needs_you'],
  ['Choose the export menu name', 'needs_you'],
  ['Fix the flaky reconnect test', 'working'],
  ['Upgrade the base image', 'working'],
  ['Draft the onboarding email', 'working'],
  ['Profile the list scroll', 'working'],
  ['Wait for the vendor reply', 'waiting']
]
const walkSeed: BotItem[] = walkRows.map(([title, status], index) =>
  makeTestBotItem(70 - index, {
    title,
    status,
    lastActivityAt: WALK_NOW - (index + 1) * WALK_MIN,
    ...(index === 1 || index === 4 ? { chat: designChat } : {})
  })
)
walkSeed.push(
  makeTestBotItem(60, { title: 'Audit connector scopes', snoozedUntil: WALK_NOW + WALK_DAY }),
  makeTestBotItem(59, {
    title: 'Rename the settings copy',
    status: 'planned',
    snoozedUntil: WALK_NOW + 2 * WALK_DAY
  }),
  makeTestBotItem(58, {
    title: 'Clean up old branches',
    lastActivityAt: WALK_NOW - 9 * WALK_DAY
  }),
  makeTestBotItem(57, {
    title: 'Retire the legacy flag',
    status: 'waiting',
    lastActivityAt: WALK_NOW - 10 * WALK_DAY,
    chat: designChat
  })
)
const walkClosed = Array.from({ length: 40 }, (_, index) =>
  makeTestBotItem(50 - index, {
    title: `Closed item ${index + 1}`,
    status: index % 4 === 3 ? 'canceled' : 'done',
    lastActivityAt: WALK_NOW - (60 + index) * WALK_MIN,
    ...(index % 7 === 0 ? { chat: designChat } : {})
  })
)
const isClosedStatus = (item: BotItem): boolean =>
  item.status === 'done' || item.status === 'canceled'

function SectionWalk({
  initialOpen = null,
  named = false
}: {
  initialOpen?: string | null
  named?: boolean
}) {
  const [seed, setSeed] = useState(walkSeed)
  // Closed rows read so far, by uid: the first page shows at open, Show more and Next read more.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(
    () => new Set(walkClosed.slice(0, 5).map((row) => row.uid))
  )
  const [filter, setFilter] = useState<BotItemFilter>(BOT_ITEM_NO_FILTER)
  const [pageFails, setPageFails] = useState(false)
  const [offline, setOffline] = useState(false)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const scroll = useRef<HTMLDivElement | null>(null)
  const universe = useMemo(() => filterBotItems([...seed, ...walkClosed], filter), [seed, filter])
  const shown = useMemo(
    () => universe.filter((row) => !walkClosed.includes(row) || loaded.has(row.uid)),
    [universe, loaded]
  )
  const groups = useMemo(() => groupBotItems(shown, WALK_STALE_DAYS, WALK_NOW, 'e10'), [shown])
  const unread = universe.filter((row) => walkClosed.includes(row) && !loaded.has(row.uid))
  const loadMoreClosed = async (): Promise<BotItemsClosedPage> => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (pageFails) {
      throw new Error('Reading more Closed items failed')
    }
    const page = unread.slice(0, 5)
    setLoaded((prev) => new Set([...prev, ...page.map((row) => row.uid)]))
    return { items: page, more: unread.length > page.length }
  }
  const list = {
    groups,
    closedTotal: filter.needsYou ? groups.closed.length : universe.filter(isClosedStatus).length,
    loadMoreClosed: filter.needsYou || unread.length === 0 ? null : loadMoreClosed,
    closedEnded: filter.needsYou || unread.length === 0
  }
  const walk = useBotItemWalk(list, `fixture:section-walk:${named ? 'group' : 'bot'}`)
  const back = (): void => {
    const left = walk.close()
    const listed = BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id].map((row) => row.uid))
    setReturnTo(left ? botItemWalkReturnRow(left.walk, left.uid, listed) : null)
  }
  const opened = useRef(false)
  useEffect(() => {
    if (initialOpen && !opened.current) {
      opened.current = true
      walk.open(initialOpen)
    }
  }, [initialOpen, walk])
  const setStatus = (uid: string | null, status: BotItem['status']): void =>
    setSeed((rows) =>
      rows.map((row) =>
        row.uid === uid
          ? {
              ...row,
              status,
              closedAt: isClosedStatus({ ...row, status }) ? WALK_NOW : null,
              lastActivityAt: Date.now()
            }
          : row
      )
    )
  const open = walk.uid
    ? (shown.find((row) => row.uid === walk.uid) ??
      seed.find((row) => row.uid === walk.uid) ??
      walkClosed.find((row) => row.uid === walk.uid))
    : null
  useBotItemBackFocus(open != null, scroll)
  const toggle = (label: string, on: boolean, flip: () => void) => (
    <button
      type="button"
      aria-pressed={on}
      className="rounded border border-border px-1.5 py-0.5 aria-pressed:bg-accent"
      onClick={flip}
    >
      {label}
    </button>
  )
  return (
    <div className="flex h-[560px] flex-col bg-sidebar">
      <div data-fixture-controls="" className="flex flex-wrap gap-1 p-1 text-[11px]">
        {toggle('Design chat', filter.chatIds !== null, () => {
          setReturnTo(null)
          setFilter((now) => ({ ...now, chatIds: now.chatIds ? null : [designChat.id] }))
        })}
        {toggle('Needs you only', filter.needsYou, () => {
          setReturnTo(null)
          setFilter((now) => ({ ...now, needsYou: !now.needsYou }))
        })}
        {toggle('Page fails', pageFails, () => setPageFails((now) => !now))}
        {toggle('Offline', offline, () => setOffline((now) => !now))}
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5"
          onClick={() => setStatus(walk.uid, 'done')}
        >
          Mark done
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5"
          onClick={() => setStatus(walkSeed[2].uid, 'working')}
        >
          Live: #68 to In progress
        </button>
      </div>
      {walk.uid && open ? (
        <BotItemPaneFrame
          walk={walk}
          offline={offline}
          onBack={back}
          owner={named ? fixtureCos : null}
        >
          {(slots) => <SectionWalkItem item={open} slots={slots} />}
        </BotItemPaneFrame>
      ) : (
        <div
          ref={scroll}
          data-bot-items-scroller=""
          tabIndex={-1}
          className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3 outline-none"
        >
          <BotItemsList
            bot={fixtureCos}
            groups={groups}
            seenEventId="e10"
            closedTotal={list.closedTotal}
            onMoreClosed={list.loadMoreClosed}
            staleDays={WALK_STALE_DAYS}
            now={WALK_NOW}
            focusUid={returnTo}
            onOpen={(row) => {
              setReturnTo(null)
              walk.open(row.uid)
            }}
            offline={offline}
            focusFallback={scroll}
            scroller={scroll}
          />
        </div>
      )}
    </div>
  )
}

function SectionWalkItem({ item: shown, slots }: { item: BotItem; slots: BotItemPaneSlots }) {
  const { onShown } = slots
  useEffect(() => onShown(shown), [onShown, shown])
  return (
    <BotItemBody
      commentRef={slots.comment}
      nav={slots.nav}
      bot={fixtureCos}
      item={shown}
      view={{
        item: shown,
        events: [],
        eventsRead: true,
        hasEarlier: false,
        failed: false,
        deleted: false,
        loadEarlier: () => {},
        retry: () => {}
      }}
    />
  )
}

/** Click a row, step with the arrows or chords, change statuses, filter and page Closed: one section only. */
export const sectionWalk = defineFixture({ width: 392, render: () => <SectionWalk /> })
/** The only Waiting item in a 220 px pane, the panel's narrowest: 1 / 1 with both arrows off. */
export const sectionWalkOnly = defineFixture({
  width: 252,
  render: () => <SectionWalk initialOpen={walkSeed[7].uid} />
})
/** The same in a bot group's panel, whose back row names the bot. */
export const sectionWalkOnlyGroup = defineFixture({
  width: 252,
  render: () => <SectionWalk initialOpen={walkSeed[7].uid} named />
})
