// A bot's items as its Items tab shows them (every open one, closed ones by page), read from the bot's
// host and re-read when its items or workers change; and the owner's writes to them.
import { useEffect, useRef, useState } from 'react'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent, BotItemStatus } from '../../../../../shared/bots/bot-items'
import type { BotItemsListRead } from '../../../../../shared/bots/bot-item-schema'
import {
  createBotHostRead,
  useBotHostRead,
  useBotHostReadState,
  type BotHostReadState
} from '../use-bot-host-read'

export type BotItemsRead = BotItemsListRead

/** Work changes come in bursts, so reads start at most this often. */
const ITEMS_MIN_READ_GAP_MS = 500

const itemsRead = createBotHostRead<BotItemsRead>(
  'bots.items.owner.list',
  (result: BotItemsRead) => result,
  'Failed to read bot items:',
  ['items', 'workers'],
  ITEMS_MIN_READ_GAP_MS
)

export function useBotItems(bot: Bot | null): {
  read: BotItemsRead | null
  state: BotHostReadState
  /** The latest re-read failed; `read` is the last good one. */
  refreshFailed: boolean
  retry: () => void
} {
  const read = useBotHostRead(itemsRead, bot)
  return { read, ...useBotHostReadState(itemsRead, bot) }
}

/** The item as the open Items tab last read it, without subscribing; null while no tab holds a read. */
export function botItemLastRead(bot: BotRef, uid: string): BotItem | null {
  return itemsRead.snapshot(botRefKey(bot))?.items.find((item) => item.uid === uid) ?? null
}

/** The seen mark as the tab opened: rows changed since keep their dot while it stays open. Opening
 *  moves the bot's mark, once the first read has said where it was. */
export function useBotItemsSeenAtOpen(bot: Bot, read: BotItemsRead | null): string | null {
  const [atOpen, setAtOpen] = useState<string | null>(null)
  const sent = useRef(false)
  const seen = read?.seenEventId ?? null
  if (atOpen === null && seen !== null) {
    setAtOpen(seen)
  }
  const { hostId, id } = bot
  useEffect(() => {
    if (seen === null || sent.current) {
      return
    }
    sent.current = true
    void callBotRpc({ hostId }, 'bots.items.owner.opened', { botId: id }).catch((error: unknown) =>
      console.warn('[bots] items: marking the tab opened failed', error)
    )
  }, [hostId, id, seen])
  return atOpen
}

/** One chat's items while the filter shows it, with its own counts and Closed pages; re-read on change. */
export function useBotChatItems(
  bot: Bot,
  chatId: string | null
): { read: BotItemsRead | null; failed: boolean; retry: () => void } {
  const { hostId, id } = bot
  const [read, setRead] = useState<{ chatId: string; value: BotItemsRead } | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (chatId === null) {
      return
    }
    let live = true
    // One read out at a time; notices during it share one more after it, so the last to land is newest.
    let reading = false
    let again = false
    const load = (): void => {
      if (reading) {
        again = true
        return
      }
      reading = true
      callBotRpc<BotItemsRead>({ hostId }, 'bots.items.owner.list', { botId: id, chatId })
        .then((value) => {
          if (live) {
            setRead({ chatId, value })
            setFailed(false)
          }
        })
        .catch((error: unknown) => {
          console.warn('[bots] items: reading a chat’s items failed', error)
          if (live) {
            setFailed(true)
          }
        })
        .finally(() => {
          reading = false
          if (again && live) {
            again = false
            load()
          }
        })
    }
    load()
    const stop = onBotsChanged(load, hostId, { botId: id, kinds: ['items', 'workers'] })
    return () => {
      live = false
      stop()
    }
  }, [hostId, id, chatId, attempt])
  return {
    read: read && read.chatId === chatId ? read.value : null,
    failed,
    retry: () => setAttempt((value) => value + 1)
  }
}

/** Closed items past the first page (of one chat's, given one), read on Show more. */
export async function readMoreClosedItems(
  bot: BotRef,
  cursor: string,
  chatId: string | null
): Promise<{ items: BotItem[]; nextClosedCursor?: string }> {
  const result = await callBotRpc<BotItemsRead>(bot, 'bots.items.owner.list', {
    botId: bot.id,
    closedCursor: cursor,
    ...(chatId !== null ? { chatId } : {})
  })
  return {
    items: result.items.filter((item) => item.status === 'done' || item.status === 'canceled'),
    ...(result.nextClosedCursor ? { nextClosedCursor: result.nextClosedCursor } : {})
  }
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

/** `images`: chat-attachment paths on the bot's host; files ride in `text` as `@path`. */
export function commentOnBotItem(
  bot: BotRef,
  uid: string,
  text: string,
  images: readonly string[] = []
): Promise<unknown> {
  return callBotRpc(bot, 'bots.items.owner.comment', {
    item: uid,
    text,
    // An older host refuses the field, so a text-only comment leaves it off.
    ...(images.length > 0 ? { images } : {})
  })
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
