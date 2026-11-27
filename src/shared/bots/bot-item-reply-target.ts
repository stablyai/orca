// What an item's comment box replies to, on the desktop and the phone: the question line its draft
// started on and whether its "Replying to" was closed. Kept in one store beside the box's draft, which
// every box on the item reads and writes, so it outlives the box (and on desktop a restart) as the
// draft does.
import type * as React from 'react'
import type { BotItemWaitingLine } from './bot-item-question-answers'
import type { BotItem } from './bot-items'

/** The box's "Replying to" on its line: closed (×), and how to close or reopen it. */
export type BotItemReplyMarkState = Pick<BotItemReplyTarget, 'hidden' | 'hide' | 'show'>

export type BotItemReplyTarget = {
  /** The line the box names; null: what it sends answers nothing. */
  line: BotItemWaitingLine | null
  /** The owner chose this line (a line's edit, Type your answer, a step): it holds in an empty box too,
   *  until a send. */
  bind: (id: string) => void
  /** The box's next draft answers no line. */
  none: () => void
  /** A send: the next draft takes the line named when it starts. */
  release: () => void
  /** The owner closed "Replying to" on `line` (its ×): the box sends a comment of its own. */
  hidden: boolean
  hide: () => void
  /** "Replying to" back on, as Type your answer does. */
  show: () => void
}

type Bound = { id: string; explicit: boolean } | 'none' | null

/** What one box's target keeps: the line its draft started on, whether the box was empty then, and
 *  the question whose "Replying to" the owner closed (×). */
type Kept = { bound: Bound; wasEmpty: boolean; hidden: string | null }

/** Where a box's target is kept, beside its draft: text under `botItemReplyTargetKey(scope)`, '' for
 *  none. The desktop keeps it in chat's draft store, so it outlives a restart as the draft does. */
export type BotItemReplyTargetStore = {
  read: (key: string) => string
  write: (key: string, value: string) => void
  subscribe: (key: string, listener: () => void) => () => void
}

const sessionTargets = new Map<string, string>()
const sessionListeners = new Map<string, Set<() => void>>()

/** For drafts kept only for the app session (the phone's). */
export const sessionBotItemReplyTargets: BotItemReplyTargetStore = {
  read: (key) => sessionTargets.get(key) ?? '',
  write: (key, value) => {
    if (value) {
      sessionTargets.set(key, value)
    } else {
      sessionTargets.delete(key)
    }
    sessionListeners.get(key)?.forEach((listener) => listener())
  },
  subscribe: (key, listener) => {
    const listeners = sessionListeners.get(key) ?? new Set()
    sessionListeners.set(key, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        sessionListeners.delete(key)
      }
    }
  }
}

/** Words the app puts back in an empty box (a refused reply's) answer no question, whether or not a
 *  box is open: set before the draft is written, so an open box reads it as it shows the words. */
export function putBackBotItemReplyTarget(store: BotItemReplyTargetStore, scope: string): void {
  const key = botItemReplyTargetKey(scope)
  const hidden = parseKept(store.read(key))?.hidden ?? null
  store.write(key, serializeKept({ bound: 'none', wasEmpty: false, hidden }))
}

/** The item is read (with its Activity) and waits on no question, so the box's kept lines are gone. */
export function botItemWaitsOnNoQuestion(
  item: BotItem | null,
  waitingAsk: unknown,
  eventsRead: boolean
): boolean {
  return eventsRead && item !== null && item.question === null && !item.waitingAsk && !waitingAsk
}

export function botItemReplyTargetKey(scope: string): string {
  return `bot-item-reply:${scope}`
}

function serializeKept({ bound, wasEmpty, hidden }: Kept): string {
  return bound === null && wasEmpty && hidden === null
    ? ''
    : JSON.stringify({ bound, wasEmpty, hidden })
}

function isBound(value: unknown): value is Bound {
  return (
    value === null ||
    value === 'none' ||
    (typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'explicit' in value &&
      typeof value.explicit === 'boolean')
  )
}

function parseKept(text: string): Kept | null {
  let value: unknown = null
  try {
    value = text ? JSON.parse(text) : null
  } catch {
    // Unreadable: kept as none.
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'bound' in value &&
    isBound(value.bound) &&
    'wasEmpty' in value &&
    typeof value.wasEmpty === 'boolean' &&
    'hidden' in value &&
    (value.hidden === null || typeof value.hidden === 'string')
  ) {
    return { bound: value.bound, wasEmpty: value.wasEmpty, hidden: value.hidden }
  }
  return null
}

type Asked = {
  open: readonly BotItemWaitingLine[]
  /** Lines a draft started on keeps naming, though the box can't name them anew (picked ones). */
  kept: readonly BotItemWaitingLine[]
  /** The item is read and waits on no question: every kept line is gone. */
  noQuestion: boolean
}

/** The kept target as the box is now: a draft's start or end moves it, and lines no longer asked go.
 *  `seenEmpty`: what this box last saw, for a box with nothing kept; `live`: it saw the draft start,
 *  so its words are for the line named then (one that arrived while it was closed names none). */
function settleKept(
  stored: Kept | null,
  seenEmpty: boolean,
  live: boolean,
  boxEmpty: boolean,
  { open, kept, noQuestion }: Asked,
  /** Drop lines no longer asked; off for a change in an event, whose `open` may predate it. */
  prune = true
): Kept {
  const asked = (id: string): boolean => open.some((line) => line.id === id)
  const keepable = (id: string): boolean => kept.some((line) => line.id === id)
  // An open line other than it, or none at all on a read item: never a line still loading or on its
  // way. A kept line goes once no draft holds it.
  const gone = (id: string): boolean =>
    !asked(id) && (keepable(id) ? boxEmpty : open.length > 0 || noQuestion)
  let { bound, wasEmpty, hidden } = stored ?? { bound: null, wasEmpty: seenEmpty, hidden: null }
  if (wasEmpty !== boxEmpty) {
    if (!boxEmpty && !live) {
      bound = 'none'
    } else if (!boxEmpty && bound !== 'none' && !(bound && asked(bound.id))) {
      bound = open[0] ? { id: open[0].id, explicit: false } : 'none'
    } else if (boxEmpty && (bound === 'none' || (bound && !bound.explicit))) {
      bound = null
    }
    wasEmpty = boxEmpty
  }
  if (prune && hidden !== null && gone(hidden)) {
    hidden = null
  }
  if (prune && bound !== null && bound !== 'none' && gone(bound.id)) {
    bound = boxEmpty ? null : 'none'
  }
  return { bound, wasEmpty, hidden }
}

/** What the comment box replies to, desktop and phone alike: the line named when its draft's first
 *  words (or a photo) arrived, until it is empty again. A later ask never moves a draft to its line:
 *  the box then names nothing, so the words go as a comment of their own. An empty box names the first
 *  of `open`. The store owns it: every box on the item reads it, and each change reads it fresh, so two
 *  changes in one event both land. A draft there when the item opens, or after a restart, names the
 *  line it named before; one restored with nothing kept (or that changed meanwhile) names none. */
export function createBotItemReplyTargetHook(
  {
    useCallback,
    useLayoutEffect,
    useRef,
    useSyncExternalStore
  }: Pick<typeof React, 'useCallback' | 'useLayoutEffect' | 'useRef' | 'useSyncExternalStore'>,
  store: BotItemReplyTargetStore = sessionBotItemReplyTargets
) {
  return function useBotItemReplyTarget(
    /** The box's draft scope: its target is kept under it. */
    scope: string,
    /** The lines the box could name now, the one an empty box names first. */
    open: readonly BotItemWaitingLine[],
    boxEmpty: boolean,
    /** The item is read and waits on no question. */
    noQuestion = false,
    /** Lines a draft started on keeps naming, though the box can't name them anew. */
    kept: readonly BotItemWaitingLine[] = []
  ): BotItemReplyTarget {
    const key = botItemReplyTargetKey(scope)
    const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key])
    const text = useSyncExternalStore(subscribe, () => store.read(key))
    const seen = useRef<{ key: string; empty: boolean } | null>(null)
    const live = seen.current?.key === key
    const seenEmpty = live && seen.current ? seen.current.empty : boxEmpty
    const asked = { open, kept, noQuestion }
    const current = settleKept(parseKept(text), seenEmpty, live, boxEmpty, asked)
    const settled = serializeKept(current)
    useLayoutEffect(() => {
      seen.current = { key, empty: boxEmpty }
      // Only over what this render read: another box's newer write re-renders this one instead.
      if (settled !== text && store.read(key) === text) {
        store.write(key, settled)
      }
    })
    const lineOf = ({ bound }: Kept): BotItemWaitingLine | null =>
      bound === 'none'
        ? null
        : ((bound && open.find((line) => line.id === bound.id)) ??
          (bound && !boxEmpty ? kept.find((line) => line.id === bound.id) : null) ??
          (boxEmpty ? open[0] : null) ??
          null)
    // Read fresh, so a second change in the same event keeps the first.
    const update = (change: (kept: Kept) => Partial<Kept>): void => {
      // Unpruned: a line this event just bound (its pick just cleared) is not in this render's `open`.
      const fresh = settleKept(parseKept(store.read(key)), boxEmpty, true, boxEmpty, asked, false)
      store.write(key, serializeKept({ ...fresh, ...change(fresh) }))
    }
    const line = lineOf(current)
    return {
      line,
      hidden: line !== null && current.hidden === line.id,
      bind: (id) => update(() => ({ bound: { id, explicit: true } })),
      none: () => update(() => ({ bound: 'none' })),
      release: () => update(() => ({ bound: null })),
      hide: () => update((kept) => ({ hidden: lineOf(kept)?.id ?? null })),
      show: () => update(() => ({ hidden: null }))
    }
  }
}
