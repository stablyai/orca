// What an item's comment box replies to, on the desktop and the phone: the question line its draft
// started on and whether its "Replying to" was closed, kept beside the box's draft so it outlives
// the box as the draft does.
import type * as React from 'react'
import type { BotItemWaitingLine } from './bot-item-question-answers'

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
}

const sessionTargets = new Map<string, string>()

/** For drafts kept only for the app session (the phone's). */
export const sessionBotItemReplyTargets: BotItemReplyTargetStore = {
  read: (key) => sessionTargets.get(key) ?? '',
  write: (key, value) => void (value ? sessionTargets.set(key, value) : sessionTargets.delete(key))
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

/** What the comment box replies to, desktop and phone alike: the line named when its draft's first
 *  words (or a photo) arrived, until it is empty again. A later ask never moves a draft to its line:
 *  the box then names nothing, so the words go as a comment of their own. An empty box names the first
 *  of `open`. The target is kept beside the draft (`store`), so a draft there when the item opens,
 *  or after a restart, names the line it named before; one that changed meanwhile names none. */
export function createBotItemReplyTargetHook(
  { useState, useLayoutEffect }: Pick<typeof React, 'useState' | 'useLayoutEffect'>,
  store: BotItemReplyTargetStore = sessionBotItemReplyTargets
) {
  return function useBotItemReplyTarget(
    /** The box's draft scope: its target is kept under it. */
    scope: string,
    /** The lines the box could name now, the one an empty box names first. */
    open: readonly BotItemWaitingLine[],
    boxEmpty: boolean
  ): BotItemReplyTarget {
    const key = botItemReplyTargetKey(scope)
    const find = (id: string): BotItemWaitingLine | null =>
      open.find((line) => line.id === id) ?? null
    const first = open[0] ?? null
    // `live`: this box's state from its last render, when it is still this scope's.
    const settle = (live: Kept | null): Kept & { key: string } => {
      const kept = parseKept(store.read(key))
      const hidden = live ? live.hidden : (kept?.hidden ?? null)
      // A draft that is as it was kept (the box shown again, or loaded after a restart) keeps it.
      if (kept && kept.wasEmpty === boxEmpty) {
        return { key, bound: kept.bound, wasEmpty: boxEmpty, hidden }
      }
      let bound = live ? live.bound : null
      if (live) {
        if (!boxEmpty && bound !== 'none' && !(bound && find(bound.id))) {
          bound = first ? { id: first.id, explicit: false } : 'none'
        } else if (boxEmpty && (bound === 'none' || (bound && !bound.explicit))) {
          bound = null
        }
      }
      return { key, bound, wasEmpty: boxEmpty, hidden }
    }
    const [state, setState] = useState(() => settle(null))
    let current = state
    if (state.key !== key || state.wasEmpty !== boxEmpty) {
      current = settle(state.key === key ? state : null)
      setState(current)
    }
    const kept = serializeKept(current)
    useLayoutEffect(() => store.write(key, kept), [key, kept])
    const save = (change: Partial<Kept>): void => setState({ ...current, ...change })
    const held = current.bound
    const line = held === 'none' ? null : ((held && find(held.id)) ?? (boxEmpty ? first : null))
    return {
      line,
      hidden: line !== null && current.hidden === line.id,
      bind: (id) => save({ bound: { id, explicit: true } }),
      none: () => save({ bound: 'none' }),
      release: () => save({ bound: null }),
      hide: () => save({ hidden: line?.id ?? null }),
      show: () => save({ hidden: null })
    }
  }
}
