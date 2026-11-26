// What an item's comment box replies to, on the desktop and the phone: the question line its draft
// started on, kept per box draft scope so it outlives the box as the draft does.
import type * as React from 'react'
import type { BotItemWaitingLine } from './bot-item-question-answers'

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
}

type ReplyTargetState = {
  bound: { id: string; explicit: boolean } | 'none' | null
  wasEmpty: boolean
}

// Per box draft scope, so the target outlives the box as its draft does (leaving the item and coming
// back). Memory only: a draft restored after a restart names none, as below.
const replyTargets = new Map<string, ReplyTargetState>()

function rememberReplyTarget(scope: string, state: ReplyTargetState): void {
  if (state.bound === null && state.wasEmpty) {
    replyTargets.delete(scope)
  } else {
    replyTargets.set(scope, state)
  }
}

/** What the comment box replies to, desktop and phone alike: the line named when its draft's first
 *  words (or a photo) arrived, until it is empty again. A later ask never moves a draft to its line:
 *  the box then names nothing, so the words go as a comment of their own. An empty box names the first
 *  of `open`; a draft already there when the item opens names the line it named when the box was last
 *  shown, or none if it changed meanwhile or was restored after a restart. */
export function createBotItemReplyTargetHook({ useState }: Pick<typeof React, 'useState'>) {
  return function useBotItemReplyTarget(
    /** The box's draft scope: its target is kept under it. */
    scope: string,
    /** The lines the box could name now, the one an empty box names first. */
    open: readonly BotItemWaitingLine[],
    boxEmpty: boolean
  ): BotItemReplyTarget {
    const initial = (): ReplyTargetState & { scope: string } => {
      const kept = replyTargets.get(scope)
      return {
        scope,
        ...(kept?.wasEmpty === boxEmpty ? kept : { bound: null, wasEmpty: boxEmpty })
      }
    }
    const [state, setState] = useState(initial)
    const current = state.scope === scope ? state : initial()
    const save = (next: ReplyTargetState): void => {
      rememberReplyTarget(scope, next)
      setState({ scope, ...next })
    }
    const find = (id: string): BotItemWaitingLine | null =>
      open.find((line) => line.id === id) ?? null
    const first = open[0] ?? null
    let held = current.bound
    if (current !== state || current.wasEmpty !== boxEmpty) {
      if (current.wasEmpty !== boxEmpty) {
        if (!boxEmpty && held !== 'none' && !(held && find(held.id))) {
          held = first ? { id: first.id, explicit: false } : 'none'
        } else if (boxEmpty && (held === 'none' || (held && !held.explicit))) {
          held = null
        }
      }
      save({ bound: held, wasEmpty: boxEmpty })
    }
    const line = held === 'none' ? null : ((held && find(held.id)) ?? (boxEmpty ? first : null))
    return {
      line,
      bind: (id) => save({ bound: { id, explicit: true }, wasEmpty: boxEmpty }),
      none: () => save({ bound: 'none', wasEmpty: boxEmpty }),
      release: () => save({ bound: null, wasEmpty: boxEmpty })
    }
  }
}
