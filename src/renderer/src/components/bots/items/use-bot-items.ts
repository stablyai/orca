// A bot's items as its Items tab shows them (every open one, closed ones by page), read from the bot's
// host and re-read when its items or workers change; and the owner's writes to them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotItem,
  BotItemCommentSkill,
  BotItemEvent,
  BotItemStatus
} from '../../../../../shared/bots/bot-items'
import type { BotItemsListRead } from '../../../../../shared/bots/bot-item-schema'
import { BOT_ITEM_LIMITS, parseBotItemEventId } from '../../../../../shared/bots/bot-items'
import {
  loadBotItemsList,
  type BotItemsListCall
} from '../../../../../shared/bots/bot-items-list-load'
import type { BotChangeKind } from '../../../../../shared/bots/bot-change-scope'
import { botItemsNoticeParts } from '../../../../../shared/bots/bot-items-notice-parts'
import { BotReadMoreFailed } from '../../../../../shared/bots/bot-read-more-failed'
import { addBotReadAsk, botReadLoadAsk, type BotReadAsk } from '../bot-host-read-asks'
import {
  createBotHostRead,
  useBotHostRead,
  type BotHostRead,
  type BotHostReadState
} from '../use-bot-host-read'
import { useBotHostReadState } from '../use-bot-host-read-state'

export type BotItemsRead = BotItemsListRead

/** Work changes come in bursts, so reads start at most this often. */
const ITEMS_MIN_READ_GAP_MS = 500

const ITEMS_KINDS: readonly BotChangeKind[] = ['items', 'workers']

/** Bots whose last Items list stays after their tabs close. */
const KEPT_ITEM_LISTS = 20

/** Rows need no description, done means or close note: the opened item reads its own. */
const SUMMARY = { summary: true }

/** The list call for a bot (or some of its chats), every read a summary. */
function listCall(bot: BotRef, chatIds: readonly string[] | null): BotItemsListCall {
  return (params) =>
    callBotRpc<BotItemsRead>(bot, 'bots.items.owner.list', {
      botId: bot.id,
      ...chatScope(chatIds),
      ...SUMMARY,
      ...params
    })
}

const itemsRead: BotHostRead<BotItemsRead> = createBotHostRead<BotItemsRead>(
  'bots.items.owner.list',
  (result: BotItemsRead) => result,
  'Failed to read bot items:',
  ITEMS_KINDS,
  ITEMS_MIN_READ_GAP_MS,
  // Reopening shows the last list at once while it re-reads (a big bot's read takes seconds), for the
  // bots read most recently.
  KEPT_ITEM_LISTS,
  {
    partsOf: (scope, botId) => botItemsNoticeParts(scope, botId),
    maxParts: BOT_ITEM_LIMITS.listPageMax,
    // The first read after a reopen builds on the kept list, whose deeper pages missed the notices while
    // it was closed: it reads every loaded page again, not only once the first page moves.
    load: (bot, previous, ask, show, live, waiting) =>
      loadBotItemsList(listCall(bot, null), previous, ask, {
        show,
        live,
        waiting,
        pageUnmoved: !itemsRead.landed(botRefKey(bot))
      })
  }
)

/** The bot's next Closed page, read in turn with its list's other reads; the list as it lands. */
export function readMoreBotItems(bot: BotRef): Promise<BotItemsRead | null> {
  return itemsRead.requestMore(bot)
}

export function useBotItems(bot: Bot | null): {
  read: BotItemsRead | null
  state: BotHostReadState
  /** The latest re-read failed; `read` is the last good one. */
  refreshFailed: boolean
  /** A read landed since this tab opened; until then `read` may be the bot's kept list. */
  landed: boolean
  retry: () => void
} {
  const read = useBotHostRead(itemsRead, bot)
  return { read, ...useBotHostReadState(itemsRead, bot) }
}

/** The item as an Items tab last read it, without subscribing; null until one has. */
export function botItemLastRead(bot: BotRef, uid: string): BotItem | null {
  return itemsRead.snapshot(botRefKey(bot))?.items.find((item) => item.uid === uid) ?? null
}

/** Each bot's mark as this window's last open moved it: a kept read from before that open is older. */
const openedMarks = new Map<string, string>()

function laterMark(read: string | null, opened: string | undefined): string | null {
  if (read === null || opened === undefined) {
    return read
  }
  return (parseBotItemEventId(opened) ?? 0) > (parseBotItemEventId(read) ?? 0) ? opened : read
}

/** The seen mark as the list opened, without moving it: rows changed since keep their dot while it
 *  stays open. It is the first read's after opening, which knows a move on another device; until that
 *  lands, the kept list shows with the newest mark this window knows. A group's list reads its members'
 *  marks this way; only a bot's own tab moves them. */
export function useBotItemsSeenMark(
  bot: BotRef,
  read: BotItemsRead | null,
  landed: boolean
): string | null {
  const [atOpen, setAtOpen] = useState<string | null>(null)
  const seen = read?.seenEventId ?? null
  if (atOpen === null && seen !== null && landed) {
    setAtOpen(seen)
  }
  return atOpen ?? (landed ? null : laterMark(seen, openedMarks.get(botRefKey(bot))))
}

/** The seen mark as the tab opened (`useBotItemsSeenMark`). Opening moves the bot's mark, once this
 *  open's first read has landed: a kept list alone never marks unseen changes seen. */
export function useBotItemsSeenAtOpen(
  bot: Bot,
  read: BotItemsRead | null,
  landed: boolean
): string | null {
  const atOpen = useBotItemsSeenMark(bot, read, landed)
  const sent = useRef(false)
  const seen = read?.seenEventId ?? null
  const { hostId, id } = bot
  useEffect(() => {
    if (seen === null || !landed || sent.current) {
      return
    }
    sent.current = true
    void callBotRpc<{ seenEventId?: string }>({ hostId }, 'bots.items.owner.opened', { botId: id })
      .then((result) => {
        if (result?.seenEventId) {
          // Overlapping opens can reply out of order: keep the newest mark.
          const key = botRefKey({ hostId, id })
          const later = laterMark(result.seenEventId, openedMarks.get(key))
          if (later) {
            openedMarks.set(key, later)
          }
        }
      })
      .catch((error: unknown) => console.warn('[bots] items: marking the tab opened failed', error))
  }, [hostId, id, seen, landed])
  return atOpen
}

/** The read's chat scope: one chat as `chatId`, which every host takes; several as `chatIds`, which a host
 *  before it ignores. Only a group's panel names several, and groups live on this computer's host. */
function chatScope(chatIds: readonly string[] | null): { chatId?: string; chatIds?: string[] } {
  return !chatIds ? {} : chatIds.length === 1 ? { chatId: chatIds[0] } : { chatIds: [...chatIds] }
}

/** The filter's chats, kept as long as they are the same chats: a new array of them reads nothing again. */
export function useStableBotItemChats(chatIds: readonly string[] | null): readonly string[] | null {
  // Session ids hold no line breaks.
  const key = chatIds ? chatIds.join('\n') : null
  return useMemo(() => (key === null ? null : key === '' ? [] : key.split('\n')), [key])
}

/** These chats' items while the filter shows them, with their own counts and Closed pages; re-read on
 *  change, one read at a time. */
export function useBotChatItems(
  bot: BotRef,
  chatIds: readonly string[] | null
): {
  read: BotItemsRead | null
  failed: boolean
  retry: () => void
  /** Their next Closed page; the list as it lands, or null when that read failed. */
  readMore: () => Promise<BotItemsRead | null>
} {
  const { hostId, id } = bot
  const chats = useStableBotItemChats(chatIds)
  const [read, setRead] = useState<{ chats: readonly string[]; value: BotItemsRead } | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const moreRef = useRef<() => Promise<BotItemsRead | null>>(async () => null)
  // The last read of these chats outlives a Retry, so it keeps its loaded Closed depth.
  const kept = useRef<{ chats: readonly string[]; value: BotItemsRead } | null>(null)
  useEffect(() => {
    if (chats === null) {
      return
    }
    const call = listCall({ hostId, id }, chats)
    let live = true
    let last: BotItemsRead | null = kept.current?.chats === chats ? kept.current.value : null
    let missed = false
    // One read out at a time; asks during it share one more after it, so the last to land is newest.
    let reading = false
    let waiting: BotReadAsk = null
    let more: ((value: BotItemsRead | null) => void)[] = []
    const start = (): void => {
      if (reading || (!waiting && more.length === 0)) {
        return
      }
      reading = true
      // After a failed read, what it missed is unknown: the next reads whole.
      const ask = botReadLoadAsk(waiting, more.length > 0, Boolean(last && !missed))
      const tell = more
      waiting = null
      more = []
      let landed: BotItemsRead | null = null
      const land = (value: BotItemsRead): void => {
        if (live && value !== last) {
          last = value
          kept.current = { chats, value }
          setRead({ chats, value })
        }
      }
      loadBotItemsList(call, last, ask, { show: land, live: () => live, pageUnmoved: true })
        .then((value) => {
          if (live) {
            landed = value
            land(value)
            missed = false
            setFailed(false)
          }
        })
        .catch((error: unknown) => {
          console.warn('[bots] items: reading a chat’s items failed', error)
          // What a read with a failed Show more read stands; that ask fails (its caller says so).
          if (error instanceof BotReadMoreFailed) {
            if (live) {
              land(error.landed)
              missed = false
              setFailed(false)
            }
          } else if (ask.whole || ask.parts.length > 0) {
            missed = true
            if (live) {
              setFailed(true)
            }
          }
        })
        .finally(() => {
          tell.forEach((told) => told(landed))
          reading = false
          if (live) {
            start()
          }
        })
    }
    const load = (uids: readonly string[] | null): void => {
      waiting = addBotReadAsk(waiting, uids, BOT_ITEM_LIMITS.listPageMax)
      start()
    }
    moreRef.current = () =>
      new Promise((told) => {
        more.push(told)
        start()
      })
    load(null)
    const stop = onBotsChanged((_host, change) => load(botItemsNoticeParts(change, id)), hostId, {
      botId: id,
      kinds: ITEMS_KINDS
    })
    return () => {
      live = false
      stop()
      more.splice(0).forEach((told) => told(null))
    }
  }, [hostId, id, chats, attempt])
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const readMore = useCallback(() => moreRef.current(), [])
  return { read: read && read.chats === chats ? read.value : null, failed, retry, readMore }
}

export type BotItemShow = {
  item: BotItem
  events: BotItemEvent[]
  nextCursor?: string
  earlierCursor?: string
}

/** Events after `after`, or with `newest` the newest page (before `before`). */
export function showBotItem(
  bot: BotRef,
  uid: string,
  page: { after: string } | { newest: true; before?: string }
): Promise<BotItemShow> {
  return callBotRpc(bot, 'bots.items.owner.show', { item: uid, ...page })
}

/** `images`: chat-attachment paths on the bot's host; files ride in `text` as `@path`. `requestId`:
 *  this comment's id, so a resend returns the comment already made; only for a host that takes it. */
export function commentOnBotItem(
  bot: BotRef,
  uid: string,
  text: string,
  images: readonly string[] = [],
  requestId?: string,
  questionId?: string,
  plain = false,
  skills: readonly BotItemCommentSkill[] = []
): Promise<unknown> {
  return callBotRpc(bot, 'bots.items.owner.comment', {
    item: uid,
    text,
    // An older host refuses these fields, so a comment without them leaves them off.
    ...(images.length > 0 ? { images } : {}),
    ...(requestId ? { requestId } : {}),
    ...(questionId ? { questionId } : {}),
    ...(plain ? { plain } : {}),
    ...(skills.length > 0 ? { skills } : {})
  })
}

/** Items by the bot that holds them, for one write per bot: a host takes only its bot's items. `bot`
 *  is their one bot, or each item's own in a group's merged list. */
export function botItemsByBot<I extends Pick<BotItem, 'uid'>>(
  items: readonly I[],
  bot: BotRef | ((item: I) => BotRef)
): [BotRef, I[]][] {
  const groups = new Map<string, [BotRef, I[]]>()
  for (const item of items) {
    const ref = typeof bot === 'function' ? bot(item) : bot
    const key = botRefKey(ref)
    const group = groups.get(key) ?? [ref, []]
    group[1].push(item)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** One status for any number of items: one mail per chat, so one turn for the bot. */
export function setBotItemsStatus(
  bot: BotRef,
  uids: readonly string[],
  status: BotItemStatus,
  reason?: string
): Promise<unknown> {
  return callBotRpc(bot, 'bots.items.owner.status', {
    items: uids,
    status,
    ...(reason ? { reason } : {})
  })
}

/** Snoozes items until `until`, or brings them back with null; no mail. Each carries the newest
 *  change by the bot that this view showed, so the host refuses a snooze over something new. */
export function snoozeBotItems(
  bot: BotRef,
  items: readonly Pick<BotItem, 'uid' | 'othersLastEventId'>[],
  until: number | null
): Promise<unknown> {
  return callBotRpc(bot, 'bots.items.owner.snooze', {
    items: items.map((item) => ({ item: item.uid, othersLastEventId: item.othersLastEventId })),
    until
  })
}
