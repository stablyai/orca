// The open item and the walk it steps through. Stepping onto a Closed item not paged in yet reads the
// next page first; the current item stays up meanwhile, and a failed read keeps the place for Retry.
import { useEffect, useRef, useState } from 'react'
import {
  botItemWalkDrop,
  botItemWalkExtend,
  botItemWalkIndex,
  botItemWalkOf,
  botItemWalkStep,
  type BotItemWalk
} from '../../../../../shared/bots/bot-item-walk'
import type { BotItemsShownList } from './use-bot-items-shown-list'

type Open = {
  uid: string
  /** Null when the item isn't in the list it opened over (a chat chip's item not loaded or filtered out). */
  walk: BotItemWalk | null
  /** Deleted while open: it leaves the walk once stepped away from. */
  gone: boolean
  /** Reopened from memory as the panel remounted: gone, it falls back to the list. */
  restored?: true
}

// Each bot's open item for the app session, like the panel's settings place: a workspace switch
// unmounts the panel, and coming back reopens it.
const openByBot = new Map<string, Open>()

export type BotItemWalkState = {
  uid: string | null
  /** 1-based place and total, or null without a walk. */
  place: { index: number; total: number } | null
  /** A Closed page is being read for a step. */
  pending: boolean
  /** The last step's page read failed. */
  failed: boolean
  canStep: (direction: 1 | -1) => boolean
  open: (uid: string) => void
  step: (direction: 1 | -1) => void
  retry: () => void
  markGone: (uid: string) => void
  /** Closes the item; returns what it left, for Back's focus. */
  close: () => { uid: string; walk: BotItemWalk | null } | null
}

/** What a walk reads of its list: one bot's, or a group's merged. */
export type BotItemWalkList = Pick<
  BotItemsShownList,
  'groups' | 'closedTotal' | 'loadMoreClosed' | 'closedEnded'
>

export function useBotItemWalk(list: BotItemWalkList, botKey: string): BotItemWalkState {
  const [current, setCurrent] = useState<Open | null>(() => {
    const kept = openByBot.get(botKey)
    return kept ? { ...kept, restored: true } : null
  })
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<1 | -1 | null>(null)
  // A page read that lands after Back or another open is dropped.
  const generation = useRef(0)
  useEffect(() => {
    if (current) {
      openByBot.set(botKey, current)
    } else {
      openByBot.delete(botKey)
    }
  }, [botKey, current])

  const settle = (next: Open | null): void => {
    generation.current++
    setCurrent(next)
    setPending(false)
    setFailed(null)
  }

  const open = (uid: string): void => {
    const walk = botItemWalkOf(list.groups, list.closedTotal)
    settle({ uid, walk: botItemWalkIndex(walk, uid) === null ? null : walk, gone: false })
  }

  const move = (from: Open, walk: BotItemWalk, to: string): void =>
    settle({ uid: to, walk: from.gone ? botItemWalkDrop(walk, from.uid) : walk, gone: false })

  const step = (direction: 1 | -1): void => {
    if (!current?.walk || pending) {
      return
    }
    const first = botItemWalkStep(current.walk, current.uid, direction)
    if (!first) {
      return
    }
    if (first.kind === 'open') {
      move(current, current.walk, first.uid)
      return
    }
    // The next member is a Closed item the walk hasn't read: the host's next page has it. The live
    // list isn't consulted, so items closed since opening stay out until Back.
    const walk = current.walk
    const loadMore = list.loadMoreClosed
    if (!loadMore) {
      // No page left: the count was more than the host holds. Otherwise a refresh is re-reading the
      // list's pages; Retry steps again once it's done.
      if (list.closedEnded) {
        setCurrent({ ...current, walk: botItemWalkExtend(walk, [], true) })
      } else {
        setFailed(direction)
      }
      return
    }
    const mine = ++generation.current
    const from = current
    setPending(true)
    setFailed(null)
    loadMore()
      .then((page) => {
        if (generation.current !== mine) {
          return
        }
        const read = botItemWalkExtend(walk, page.items, !page.more)
        const next = botItemWalkStep(read, from.uid, direction)
        if (next?.kind === 'open') {
          move(from, read, next.uid)
        } else {
          setCurrent({ ...from, walk: read })
          setPending(false)
        }
      })
      .catch((error: unknown) => {
        console.warn('[bots] items: reading closed items for the next item failed', error)
        if (generation.current === mine) {
          setPending(false)
          setFailed(direction)
        }
      })
  }

  const index = current?.walk ? botItemWalkIndex(current.walk, current.uid) : null
  return {
    uid: current?.uid ?? null,
    place: current?.walk && index !== null ? { index: index + 1, total: current.walk.total } : null,
    pending,
    failed: failed !== null,
    canStep: (direction) =>
      !pending &&
      current?.walk != null &&
      botItemWalkStep(current.walk, current.uid, direction) !== null,
    open,
    step,
    retry: () => {
      if (failed !== null) {
        step(failed)
      }
    },
    markGone: (uid) =>
      setCurrent((prev) =>
        prev?.uid !== uid ? prev : prev.restored ? null : prev.gone ? prev : { ...prev, gone: true }
      ),
    close: () => {
      const left = current ? { uid: current.uid, walk: current.walk } : null
      settle(null)
      return left
    }
  }
}
