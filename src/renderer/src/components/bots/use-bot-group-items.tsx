// A group's Items as one list: each member's items, asks and counts read as its own panel reads them
// (the same shared host reads), then merged. Read-only: the members' seen marks stay where they are.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBotHostOffline } from '@/lib/bot-host-views'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItem } from '../../../../shared/bots/bot-items'
import {
  botItemsByDispatch,
  groupBotsItems,
  botItemsClosedInTimeOrder,
  type BotItemFilter,
  type BotItemGroups
} from '../../../../shared/bots/bot-item-groups'
import { isOpenBotItemStatus } from '../../../../shared/bots/bot-items'
import { botAutomationCardRows, botNextRun } from './bot-automation-card'
import { useBotActivity } from './use-bot-activity'
import { useBotNeedsYouCount, useBotNow, type BotNeedView } from './use-bot-now'
import type { BotHostReadState } from './use-bot-host-read'
import type { StoppedForSignIn } from './BotNeedRow'
import { useBotItems } from './items/use-bot-items'
import { useBotItemsSeenMark } from './items/use-bot-items-seen-mark'
import {
  useBotItemsShownList,
  type BotItemsClosedPage,
  type BotItemsShownList
} from './items/use-bot-items-shown-list'
import type { BotItemWalkList } from './items/use-bot-item-walk'

/** One member as the group panel reads it. */
type MemberRead = {
  bot: Bot
  /** Its item read: loading, ready or failed. */
  state: BotHostReadState
  retry: () => void
  /** Null until its first read says where its seen mark was; its rows wait for it. */
  seenEventId: string | null
  list: BotItemsShownList
  /** Its asks, keys made unique across members. */
  needs: readonly BotNeedView[]
  stoppedForSignIn: readonly StoppedForSignIn[]
  /** Its whole Needs you count, as its own Items tab badge says it. */
  needsYou: number
  working: number
  /** When it next runs something, for the header's Idle line. */
  nextAt: number | null
  offline: boolean
}

const MemberReader = memo(function MemberReader({
  bot,
  filter,
  now,
  report
}: {
  bot: Bot
  /** Needs you only; which bots show is the merge's choice. */
  filter: BotItemFilter
  now: number
  report: (botId: string, read: MemberRead | null) => void
}): null {
  const items = useBotItems(bot)
  const read = items.read
  const seenEventId = useBotItemsSeenMark(bot, read, items.landed)
  const list = useBotItemsShownList(bot, read, filter, now, seenEventId ?? '')
  const botNow = useBotNow(bot)
  const needsYou = useBotNeedsYouCount(bot, botNow)
  const activity = useBotActivity(bot)
  const offline = useBotHostOffline(bot.hostId)
  const nextAt = useMemo(
    () => botNextRun(botAutomationCardRows(bot, activity, now))?.nextAt ?? null,
    [bot, activity, now]
  )
  const needs = useMemo(
    () => botNow.needs.map((need) => ({ ...need, key: `${bot.id}:${need.key}` })),
    [botNow.needs, bot.id]
  )
  const stoppedForSignIn = useMemo(
    () =>
      botNow.stoppedForSignIn.map((row) => ({
        ...row,
        key: `${bot.id}:${row.key}`,
        hostId: bot.hostId
      })),
    [botNow.stoppedForSignIn, bot.id, bot.hostId]
  )
  const { retry } = items
  // A kept list whose first refresh since opening failed counts as failed, so the group offers Retry as it
  // did when nothing was kept.
  const state = items.refreshFailed && !items.landed ? 'failed' : items.state
  const { working } = botNow
  // The list's parts, not the object the hook builds each render, so a report goes up only on change.
  const { read: listRead, items: listItems, shown, groups, staleDays } = list
  const { closedTotal, loadMoreClosed, closedEnded, closedEndAt } = list
  const {
    read: chatListRead,
    failed: chatFailed,
    retry: chatRetry,
    readMore: chatReadMore
  } = list.chatRead
  useEffect(() => {
    report(bot.id, {
      bot,
      state,
      retry,
      seenEventId,
      list: {
        read: listRead,
        chatRead: {
          read: chatListRead,
          failed: chatFailed,
          retry: chatRetry,
          readMore: chatReadMore
        },
        items: listItems,
        shown,
        groups,
        staleDays,
        closedTotal,
        loadMoreClosed,
        closedEnded,
        closedEndAt
      },
      needs,
      stoppedForSignIn,
      needsYou,
      working,
      nextAt,
      offline
    })
  }, [
    report,
    bot,
    state,
    retry,
    seenEventId,
    listRead,
    chatListRead,
    chatFailed,
    chatRetry,
    chatReadMore,
    listItems,
    shown,
    groups,
    staleDays,
    closedTotal,
    loadMoreClosed,
    closedEnded,
    closedEndAt,
    needs,
    stoppedForSignIn,
    needsYou,
    working,
    nextAt,
    offline
  ])
  useEffect(() => () => report(bot.id, null), [report, bot.id])
  return null
})

// Each read's seen marks by bot id, built the first time a list asks (so not while an item is open).
const seenIndexes = new WeakMap<readonly MemberRead[], Map<string, string | null>>()
function seenIndexOf(reads: readonly MemberRead[]): Map<string, string | null> {
  let index = seenIndexes.get(reads)
  if (!index) {
    index = new Map(reads.map((read) => [read.bot.id, read.seenEventId]))
    seenIndexes.set(reads, index)
  }
  return index
}

/** A member's loaded Closed items as the filter shows them, and whether it has more pages. */
function memberClosed(read: MemberRead): {
  closed: BotItem[]
  more: boolean
  endAt: number | null
} {
  return {
    closed: read.list.shown.filter((item) => item.status === 'done' || item.status === 'canceled'),
    more: !read.list.closedEnded,
    endAt: read.list.closedEndAt ?? null
  }
}

export type BotGroupItems = {
  /** Mount once: it reads every member. */
  readers: React.ReactNode
  /** The merged list, for the rows and the open item's walk. */
  list: BotItemWalkList & { groups: BotItemGroups }
  /** Every shown member's item read has landed with its seen mark. */
  ready: boolean
  /** A shown member's item read failed and none is left loading: its Retry. */
  failedRetry: (() => void) | null
  /** Every member read, filtered by chat only: for the Bot section's counts and the item's bot. */
  reads: readonly MemberRead[]
  /** Loaded items, the filter's bots only; Needs you only applied. */
  shown: readonly BotItem[]
  needs: readonly BotNeedView[]
  stoppedForSignIn: readonly StoppedForSignIn[]
  itemOf: (dispatchId: string) => BotItem | null
  needBot: (need: BotNeedView) => Bot
  botOf: (item: BotItem) => Bot
  /** The open item's bot; null for an item no read holds yet. */
  botOfUid: (uid: string) => Bot | null
  seenOf: (item: BotItem) => string
  /** Whole-member counts, unfiltered: the header and the tab badge. */
  needsYou: number
  working: number
  /** The soonest run among the members, and whose. */
  next: { bot: Bot; at: number } | null
  /** Open items per member in the filter's chats. */
  openCounts: ReadonlyMap<string, number>
  /** A member's host is down: the list's actions are off. */
  offline: boolean
}

export function useBotGroupItems(
  members: readonly Bot[],
  filter: BotItemFilter,
  now: number
): BotGroupItems {
  const [byBot, setByBot] = useState<ReadonlyMap<string, MemberRead>>(new Map())
  const report = useCallback((botId: string, read: MemberRead | null) => {
    setByBot((current) => {
      const next = new Map(current)
      if (read) {
        next.set(botId, read)
      } else {
        next.delete(botId)
      }
      return next
    })
  }, [])
  // The members read all their work; the bot filter picks among them below.
  const memberFilter = useMemo(
    () => ({ chatIds: null, botIds: null, needsYou: filter.needsYou }),
    [filter.needsYou]
  )
  const readers = members.map((bot) => (
    <MemberReader key={bot.id} bot={bot} filter={memberFilter} now={now} report={report} />
  ))
  const reads = useMemo(() => members.flatMap((bot) => byBot.get(bot.id) ?? []), [members, byBot])
  const shownReads = useMemo(
    () => reads.filter((read) => filter.botIds === null || filter.botIds.includes(read.bot.id)),
    [reads, filter.botIds]
  )
  // Each drawn row asks for its bot's seen mark, again whenever the panel scrolls it into the drawn range.
  const seenOf = useCallback(
    (item: BotItem): string => seenIndexOf(shownReads).get(item.owner.botId) ?? '',
    [shownReads]
  )
  const ready =
    shownReads.length === members.filter((bot) => filter.botIds?.includes(bot.id) ?? true).length &&
    shownReads.every((read) => read.list.read !== null && read.seenEventId !== null)
  const groups = useMemo(() => {
    const grouped = groupBotsItems(
      shownReads.map((read) => ({
        items: read.list.shown,
        staleDays: read.list.staleDays,
        seenEventId: read.seenEventId ?? ''
      })),
      now
    )
    // Closed lists only what time order already settles across members; the rest waits for pages.
    const settled = new Set(
      botItemsClosedInTimeOrder(shownReads.map(memberClosed)).map((item) => item.uid)
    )
    return { ...grouped, closed: grouped.closed.filter((item) => settled.has(item.uid)) }
  }, [shownReads, now])
  // Whose each paged item is, before its member's read reports it: the walk opens it at once.
  const pagedOwners = useRef(new Map<string, string>())
  const loadMoreClosed = useMemo(() => {
    if (!shownReads.some((read) => read.list.loadMoreClosed)) {
      return null
    }
    // One page from each member with more, then what time order settles of everything loaded: the
    // walk takes the members it hasn't seen in that order, so Next steps back in time.
    return async (): Promise<BotItemsClosedPage> => {
      const members = await Promise.all(
        shownReads.map(async (read) => {
          const closed = memberClosed(read)
          if (!read.list.loadMoreClosed) {
            return closed
          }
          const page = await read.list.loadMoreClosed()
          return { closed: [...closed.closed, ...page.items], more: page.more, endAt: null }
        })
      )
      for (const item of members.flatMap((member) => member.closed)) {
        pagedOwners.current.set(item.uid, item.owner.botId)
      }
      return {
        items: botItemsClosedInTimeOrder(members),
        more: members.some((member) => member.more)
      }
    }
  }, [shownReads])
  const botByUid = useMemo(() => {
    const map = new Map<string, Bot>()
    for (const read of reads) {
      for (const item of read.list.items) {
        map.set(item.uid, read.bot)
      }
    }
    return map
  }, [reads])
  const botById = useMemo(() => new Map(members.map((bot) => [bot.id, bot])), [members])
  const needs = useMemo(() => shownReads.flatMap((read) => read.needs), [shownReads])
  const needBots = useMemo(
    () => new Map(shownReads.flatMap((read) => read.needs.map((need) => [need.key, read.bot]))),
    [shownReads]
  )
  const itemOf = useMemo(() => {
    const byDispatch = botItemsByDispatch(reads.flatMap((read) => read.list.read?.items ?? []))
    return (dispatchId: string) => byDispatch.get(dispatchId) ?? null
  }, [reads])
  const failed = shownReads.find((read) => read.state === 'failed')
  const next = reads.reduce<{ bot: Bot; at: number } | null>(
    (soonest, read) =>
      read.nextAt !== null && (soonest === null || read.nextAt < soonest.at)
        ? { bot: read.bot, at: read.nextAt }
        : soonest,
    null
  )
  const openCounts = useMemo(
    () =>
      new Map(
        reads.map((read) => [
          read.bot.id,
          read.list.items.filter((item) => isOpenBotItemStatus(item.status)).length
        ])
      ),
    [reads]
  )
  return {
    readers,
    list: {
      groups,
      closedTotal: shownReads.reduce((sum, read) => sum + read.list.closedTotal, 0),
      loadMoreClosed,
      closedEnded: shownReads.every((read) => read.list.closedEnded)
    },
    ready,
    failedRetry: failed?.retry ?? null,
    reads,
    shown: useMemo(() => shownReads.flatMap((read) => read.list.shown), [shownReads]),
    needs,
    stoppedForSignIn: useMemo(
      () => shownReads.flatMap((read) => read.stoppedForSignIn),
      [shownReads]
    ),
    itemOf,
    // Built from the same asks and items: every one listed is a member's own.
    needBot: (need) => needBots.get(need.key)!,
    botOf: (item) => botById.get(item.owner.botId)!,
    botOfUid: (uid) => {
      const owner = pagedOwners.current.get(uid)
      return botByUid.get(uid) ?? (owner ? (botById.get(owner) ?? null) : null)
    },
    seenOf,
    needsYou: reads.reduce((sum, read) => sum + read.needsYou, 0),
    working: reads.reduce((sum, read) => sum + read.working, 0),
    next,
    openCounts,
    offline: shownReads.some((read) => read.offline)
  }
}
