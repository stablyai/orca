// A bot's items as its Items tab shows them (every open one, closed ones by page), read from the bot's
// host and re-read when its items or workers change; and the owner's writes to them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { BotItemAnswer } from '../../../../../shared/bots/bot-item-ask'
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

/** The seen mark as the list opened, without moving it: rows changed since keep their dot while it
 *  stays open. A group's list reads its members' marks this way; only a bot's own tab moves them. */
export function useBotItemsSeenMark(read: BotItemsRead | null): string | null {
  const [atOpen, setAtOpen] = useState<string | null>(null)
  const seen = read?.seenEventId ?? null
  if (atOpen === null && seen !== null) {
    setAtOpen(seen)
  }
  return atOpen
}

/** The seen mark as the tab opened (`useBotItemsSeenMark`). Opening moves the bot's mark, once the
 *  first read has said where it was. */
export function useBotItemsSeenAtOpen(bot: Bot, read: BotItemsRead | null): string | null {
  const atOpen = useBotItemsSeenMark(read)
  const sent = useRef(false)
  const seen = read?.seenEventId ?? null
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
 *  change. */
export function useBotChatItems(
  bot: BotRef,
  chatIds: readonly string[] | null
): { read: BotItemsRead | null; failed: boolean; retry: () => void } {
  const { hostId, id } = bot
  const chats = useStableBotItemChats(chatIds)
  const [read, setRead] = useState<{ chats: readonly string[]; value: BotItemsRead } | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (chats === null) {
      return
    }
    const scope = chatScope(chats)
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
      callBotRpc<BotItemsRead>({ hostId }, 'bots.items.owner.list', { botId: id, ...scope })
        .then((value) => {
          if (live) {
            setRead({ chats, value })
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
  }, [hostId, id, chats, attempt])
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return { read: read && read.chats === chats ? read.value : null, failed, retry }
}

/** Closed items past the first page (of some chats', given them), read on Show more. */
export async function readMoreClosedItems(
  bot: BotRef,
  cursor: string,
  chatIds: readonly string[] | null
): Promise<{ items: BotItem[]; nextClosedCursor?: string }> {
  const result = await callBotRpc<BotItemsRead>(bot, 'bots.items.owner.list', {
    botId: bot.id,
    closedCursor: cursor,
    ...chatScope(chatIds)
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

/** `images`: chat-attachment paths on the bot's host; files ride in `text` as `@path`. `requestId`:
 *  this comment's id, so a resend returns the comment already made; only for a host that takes it. */
export function commentOnBotItem(
  bot: BotRef,
  uid: string,
  text: string,
  images: readonly string[] = [],
  requestId?: string
): Promise<unknown> {
  return callBotRpc(bot, 'bots.items.owner.comment', {
    item: uid,
    text,
    // An older host refuses these fields, so a comment without them leaves them off.
    ...(images.length > 0 ? { images } : {}),
    ...(requestId ? { requestId } : {})
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

/** How an answer went: recorded (also when a retry found its first write), refused because the question
 *  closed first, or refused by a host that predates answers (it never keeps one as a plain comment). */
export type BotItemAnswerOutcome = 'answered' | 'closed' | 'unsupported'

/** The owner's answer to the item's open question. `answerId` stays the same across retries of one
 *  answer, so the host records it once. Other failures throw. */
export async function answerBotItem(
  bot: BotRef,
  uid: string,
  question: string,
  answers: readonly BotItemAnswer[],
  answerId: string
): Promise<BotItemAnswerOutcome> {
  try {
    const result = await callBotRpc(bot, 'bots.items.owner.comment', {
      item: uid,
      // Empty: the host spells the answer out. An older host refuses an empty comment instead.
      text: '',
      answering: question,
      answers: [...answers],
      answerId
    })
    return isRecord(result) && result.answered === true ? 'answered' : 'unsupported'
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'question_closed')) {
      return 'closed'
    }
    // An older host: its params refuse the answer's fields or its empty text. A current host's own
    // refusal of the answer ("Your answers come to …") is no such sign, so it surfaces as an error.
    if (error instanceof Error && /Missing text|answering|answerId/.test(error.message)) {
      return 'unsupported'
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
