import { useEffect, useMemo, useRef, useState } from 'react'
import { useOrcaWindowForegroundFocused } from '@/attention/use-orca-window-foreground-focused'
import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'
import type { BotItemActivityEntry } from '../../../../../shared/bots/bot-item-activity'
import { parseBotItemEventId } from '../../../../../shared/bots/bot-items'
import { BOT_ITEM_COMMENT_ATTRIBUTE } from './bot-item-comment-reveal'

const STORAGE_KEY = 'orca.bots.itemActivityRead'
const MAX_ITEMS = 500
const NO_CURSOR = -1
// Any positive intersection, including a small viewport inside a very tall card.
const READ_VISIBILITY_THRESHOLD = Number.EPSILON
const unsaved = new Map<string, number>()

function storedCursors(): Map<string, number> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return new Map(
        Object.entries(stored).filter(
          (entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] >= 0
        )
      )
    }
  } catch {}
  return new Map()
}

function remember(key: string, id: number): void {
  const stored = storedCursors()
  for (const [item, position] of unsaved) {
    stored.set(item, Math.max(position, stored.get(item) ?? NO_CURSOR))
  }
  const latest = Math.max(id, stored.get(key) ?? NO_CURSOR)
  stored.delete(key)
  stored.set(key, latest)
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...stored].slice(-MAX_ITEMS)))
    )
    unsaved.clear()
  } catch {
    unsaved.delete(key)
    unsaved.set(key, latest)
    const oldest = unsaved.keys().next().value
    if (unsaved.size > MAX_ITEMS && oldest !== undefined) {
      unsaved.delete(oldest)
    }
  }
}

function watchVisibleActivity(
  root: HTMLElement,
  targets: ReadonlyMap<Element, number>,
  onVisible: (ids: number[]) => void
): () => void {
  let observer: IntersectionObserver | undefined
  let inset: string | undefined
  const observe = () => {
    const top = root.style.scrollPaddingTop || '0px'
    if (top === inset) {
      return
    }
    inset = top
    observer?.disconnect()
    observer = new IntersectionObserver(
      (rows, source) => {
        if (source !== observer || !isOrcaWindowForegroundFocused()) {
          return
        }
        const visible: number[] = []
        for (const row of rows) {
          const id = targets.get(row.target)
          if (id !== undefined && row.intersectionRatio >= READ_VISIBILITY_THRESHOLD) {
            visible.push(id)
          }
        }
        onVisible(visible)
      },
      { root, rootMargin: `-${top} 0px 0px 0px`, threshold: READ_VISIBILITY_THRESHOLD }
    )
    for (const target of targets.keys()) {
      observer.observe(target)
    }
  }
  // The sticky header publishes the obscured viewport height as scroll padding.
  const resize = new MutationObserver(observe)
  resize.observe(root, { attributeFilter: ['style'] })
  observe()
  return () => {
    resize.disconnect()
    observer?.disconnect()
    observer = undefined
  }
}

export function useBotItemActivityRead({
  key,
  list,
  scroll,
  entries,
  firstEvent,
  readThrough,
  hasEarlier
}: {
  key: string
  list: React.RefObject<HTMLDivElement | null>
  scroll?: React.RefObject<HTMLDivElement | null>
  entries: readonly BotItemActivityEntry[]
  firstEvent: string | undefined
  readThrough: string | undefined
  hasEarlier: boolean
}): string | undefined {
  const [atOpen] = useState(() =>
    Math.max(storedCursors().get(key) ?? NO_CURSOR, unsaved.get(key) ?? NO_CURSOR)
  )
  const cursor = useRef(atOpen)
  const seen = useRef(new Set<number>())
  const enabled = readThrough !== undefined && scroll !== undefined
  const focused = useOrcaWindowForegroundFocused(enabled)
  const incoming = useMemo(() => {
    const comments = new Map<string, number>()
    for (const entry of entries) {
      if (entry.kind === 'comment' && entry.event.actor.kind !== 'owner' && !entry.onAsk) {
        const id = parseBotItemEventId(entry.event.id)
        if (id !== null) {
          comments.set(entry.event.id, id)
        }
      }
    }
    return comments
  }, [entries])
  const oldest = firstEvent === undefined ? 0 : (parseBotItemEventId(firstEvent) ?? 0)
  const through = readThrough === undefined ? 0 : (parseBotItemEventId(readThrough) ?? 0)
  let divider: string | undefined
  if (atOpen !== NO_CURSOR) {
    // A later refresh cannot move the boundary. Paging back can reveal its earlier rows.
    for (const [eventId, id] of incoming) {
      if (id > atOpen && id <= through) {
        divider = eventId
        break
      }
    }
  }

  useEffect(() => {
    const root = scroll?.current
    const activity = list.current
    if (!root || !activity || !focused || typeof IntersectionObserver === 'undefined') {
      return
    }
    const ids = [...incoming.values()].sort((a, b) => a - b)
    const visible = seen.current
    const noIncomingInView = ids.length === 0 ? activity.parentElement : null
    const advance = () => {
      let next = cursor.current
      if (next === NO_CURSOR) {
        // First visit establishes a baseline at the visible history, including a page without comments from others.
        for (const id of visible) {
          next = Math.max(next, id)
        }
      } else if (!hasEarlier || oldest <= next + 1) {
        // Seeing a later card must not cross an unseen card or an unloaded page.
        for (const id of ids) {
          if (id > next) {
            if (!visible.has(id)) {
              break
            }
            next = id
          }
        }
      }
      if (next > cursor.current) {
        cursor.current = next
        for (const id of visible) {
          if (id <= next) {
            visible.delete(id)
          }
        }
        remember(key, next)
      }
    }
    advance()
    const targets = new Map<Element, number>()
    if (noIncomingInView && cursor.current === NO_CURSOR) {
      targets.set(noIncomingInView, through)
    }
    for (const row of activity.querySelectorAll(`[${BOT_ITEM_COMMENT_ATTRIBUTE}]`)) {
      const id = incoming.get(row.getAttribute(BOT_ITEM_COMMENT_ATTRIBUTE) ?? '')
      if (id !== undefined && id > cursor.current) {
        targets.set(row, id)
      }
    }
    if (targets.size === 0) {
      return
    }
    return watchVisibleActivity(root, targets, (visibleIds) => {
      for (const id of visibleIds) {
        if (id > cursor.current) {
          visible.add(id)
        }
      }
      advance()
    })
  }, [focused, hasEarlier, incoming, key, list, oldest, scroll, through])

  return divider
}
