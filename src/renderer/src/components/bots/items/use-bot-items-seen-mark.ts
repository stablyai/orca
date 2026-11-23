// The "new since you last looked" mark an Items list opens with, and the tab marking itself opened.
import { useEffect, useRef, useState } from 'react'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { parseBotItemEventId } from '../../../../../shared/bots/bot-items'
import { KEPT_ITEM_LISTS, type BotItemsRead } from './use-bot-items'

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
            // Newest last, bounded like the kept lists the marks go with.
            openedMarks.delete(key)
            openedMarks.set(key, later)
            const oldest =
              openedMarks.size > KEPT_ITEM_LISTS ? openedMarks.keys().next().value : undefined
            if (oldest !== undefined) {
              openedMarks.delete(oldest)
            }
          }
        }
      })
      .catch((error: unknown) => console.warn('[bots] items: marking the tab opened failed', error))
  }, [hostId, id, seen, landed])
  return atOpen
}
