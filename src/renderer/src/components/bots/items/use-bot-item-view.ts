// One item as its view shows it, read by uid (so any item opens, however old): the item, its newest
// Activity page with older pages on demand, and each change after appended, never re-read whole.
// It paints at once from the list's row or the last read of it, then reads what changed since.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { mergeBotItemEvents } from '../../../../../shared/bots/bot-item-merge'
import { showBotItem } from './use-bot-items'

export type BotItemViewRead = {
  item: BotItem | null
  events: BotItemEvent[]
  /** False while the item shows from its list row and its Activity is still being read. */
  eventsRead: boolean
  /** Older events wait behind Show earlier. */
  hasEarlier: boolean
  failed: boolean
  /** The host has no such item any more; the last read, if any, stays up. */
  deleted: boolean
  loadEarlier: () => void
  retry: () => void
}

/** Reads preceding pages until the waiting question and its quick replies can be rendered. */
export function useWaitingQuestionPage(
  questionId: string | undefined,
  { events, eventsRead, hasEarlier, failed, loadEarlier }: BotItemViewRead
): boolean {
  const needsPage =
    !failed &&
    eventsRead &&
    hasEarlier &&
    questionId !== undefined &&
    !events.some(({ id }) => id === questionId)
  const earliest = events[0]?.id
  useEffect(() => {
    if (needsPage) {
      loadEarlier()
    }
  }, [needsPage, earliest, loadEarlier])
  return needsPage
}

type Loaded = {
  item: BotItem
  events: BotItemEvent[]
  earlierCursor: string | null
  eventsRead: boolean
}

// The items shown last, so reopening one (Back, then the same row; a step back) paints at once.
const SHOWN_LIMIT = 20
const shown = new Map<string, Loaded>()

function keepShown(key: string, loaded: Loaded | null): void {
  shown.delete(key)
  if (!loaded?.eventsRead) {
    return
  }
  shown.set(key, loaded)
  const oldest = shown.keys().next().value
  if (shown.size > SHOWN_LIMIT && oldest !== undefined) {
    shown.delete(oldest)
  }
}

/** `listed`: the item's list row, shown until the first read of its Activity lands. */
export function useBotItemView(bot: BotRef, uid: string, listed?: BotItem): BotItemViewRead {
  const { hostId, id } = bot
  const key = `${hostId}\0${id}\0${uid}`
  const [loaded, setLoaded] = useState<Loaded | null>(
    () =>
      shown.get(key) ??
      (listed ? { item: listed, events: [], earlierCursor: null, eventsRead: false } : null)
  )
  const [failed, setFailed] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const current = useRef<Loaded | null>(null)
  useLayoutEffect(() => {
    current.current = loaded
    keepShown(key, deleted ? null : loaded)
  }, [key, loaded, deleted])

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
        if (!known?.eventsRead) {
          const page = await showBotItem(ref, uid, { newest: true })
          if (live) {
            setLoaded({
              item: page.item,
              events: page.events,
              earlierCursor: page.earlierCursor ?? null,
              eventsRead: true
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
            setLoaded((prev) => withChanges(prev, item, added))
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
    eventsRead: loaded?.eventsRead ?? false,
    hasEarlier: Boolean(loaded?.earlierCursor),
    failed: failed && !deleted,
    deleted,
    loadEarlier,
    retry: () => setAttempt((value) => value + 1)
  }
}

/** A re-read that changed nothing keeps the shown state, so the open item doesn't redraw. */
function withChanges(prev: Loaded | null, item: BotItem, added: BotItemEvent[]): Loaded | null {
  if (!prev) {
    return prev
  }
  const events = added.length > 0 ? mergeBotItemEvents(prev.events, added) : prev.events
  const sameItem = JSON.stringify(item) === JSON.stringify(prev.item)
  if (sameItem && events.length === prev.events.length) {
    return prev
  }
  return { ...prev, item: sameItem ? prev.item : item, events }
}

function isItemGone(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'not_found'
}
