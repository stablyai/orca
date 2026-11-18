// One item as its view shows it, read by uid (so any item opens, however old): the item, its newest
// Activity page with older pages on demand, and each change after appended, never re-read whole.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { mergeBotItemEvents } from '../../../../../shared/bots/bot-item-merge'
import { showBotItem } from './use-bot-items'

export type BotItemViewRead = {
  item: BotItem | null
  events: BotItemEvent[]
  /** Older events wait behind Show earlier. */
  hasEarlier: boolean
  failed: boolean
  /** The host has no such item any more; the last read, if any, stays up. */
  deleted: boolean
  loadEarlier: () => void
  retry: () => void
}

type Loaded = { item: BotItem; events: BotItemEvent[]; earlierCursor: string | null }

export function useBotItemView(bot: Bot, uid: string): BotItemViewRead {
  const { hostId, id } = bot
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const current = useRef<Loaded | null>(null)
  useLayoutEffect(() => {
    current.current = loaded
  }, [loaded])

  useEffect(() => {
    let live = true
    const ref = { hostId, id }
    // Only one read runs at a time; a change during it reads once more after.
    let running = false
    let again = false
    const read = async (): Promise<void> => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        const known = current.current
        if (!known) {
          const page = await showBotItem(ref, uid, { newest: true })
          if (live) {
            setLoaded({
              item: page.item,
              events: page.events,
              earlierCursor: page.earlierCursor ?? null
            })
          }
        } else {
          // Changes since: only the events after the newest one shown.
          let after = known.events.at(-1)?.id
          let item = known.item
          const added: BotItemEvent[] = []
          for (;;) {
            const page = await showBotItem(ref, uid, after ? { after } : { newest: true })
            item = page.item
            added.push(...page.events.filter((event) => event.id !== after))
            if (!page.nextCursor || !after) {
              break
            }
            after = page.nextCursor
          }
          if (live) {
            setLoaded((prev) =>
              prev ? { ...prev, item, events: mergeBotItemEvents(prev.events, added) } : prev
            )
          }
        }
        if (live) {
          setFailed(false)
        }
      } catch (error) {
        if (live && isItemGone(error)) {
          setDeleted(true)
        } else {
          console.warn('[bots] items: reading an item failed', error)
          if (live) {
            setFailed(true)
          }
        }
      }
      // After the catch, so no error skips it (no finally: the React Compiler can't take one).
      running = false
      if (again && live) {
        again = false
        void read()
      }
    }
    void read()
    const stop = onBotsChanged(() => void read(), hostId, {
      botId: id,
      kinds: ['items', 'workers']
    })
    return () => {
      live = false
      stop()
    }
  }, [hostId, id, uid, attempt])

  const loadEarlier = useCallback(() => {
    const before = current.current?.earlierCursor
    if (!before) {
      return
    }
    void showBotItem({ hostId, id }, uid, { newest: true, before })
      .then((page) =>
        setLoaded((prev) =>
          prev
            ? {
                ...prev,
                events: mergeBotItemEvents(page.events, prev.events),
                earlierCursor: page.earlierCursor ?? null
              }
            : prev
        )
      )
      .catch((error: unknown) => {
        console.warn('[bots] items: reading earlier activity failed', error)
        setFailed(true)
      })
  }, [hostId, id, uid])

  return {
    item: loaded?.item ?? null,
    events: loaded?.events ?? [],
    hasEarlier: Boolean(loaded?.earlierCursor),
    failed: failed && !deleted,
    deleted,
    loadEarlier,
    retry: () => setAttempt((value) => value + 1)
  }
}

function isItemGone(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'not_found'
}
