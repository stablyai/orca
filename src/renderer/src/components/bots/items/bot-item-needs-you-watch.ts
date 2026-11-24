// Where an item's Needs you entry sits against the scroller's view, and the state of a jump to it, kept
// outside React: the entry crossing the view's edge re-renders only the jump pill, never the page.
// Two IntersectionObservers on the entry's top edge say where it is; nothing is read on scroll.
import { BOT_ITEM_NEEDS_YOU_TOP_ATTRIBUTE } from './BotItemNeedsYouMark'

/** The entry's top: in view, or which way to scroll to it. Null while not observed yet; `undrawn`
 *  while no entry is marked (its page not read yet). */
export type BotItemNeedsYouPlace = 'visible' | 'above' | 'below' | 'undrawn' | null

export type BotItemNeedsYouJumpState = {
  /** Counts jumps: each one opens the entry's cut text. */
  opened: number
  /** A jump landed since the item last needed the owner. */
  jumped: boolean
  /** A jump waits on earlier pages to draw the entry. */
  pending: boolean
}

export type BotItemNeedsYouWatch = ReturnType<typeof createBotItemNeedsYouWatch>

// The soft edge over the comment box hides the scroller's last pixels.
const BOTTOM_EDGE = 16
const VISIBLE_RATIO = 0.99
// Far enough above the view to hold any page of Activity.
const FAR = 1_000_000

export function createBotItemNeedsYouWatch() {
  let node: HTMLElement | null = null
  let root: HTMLElement | null = null
  let observers: IntersectionObserver[] = []
  // Whether the entry's top shows, and whether it is above the view's bottom (so not below it). The
  // second says which way when a jump carries the entry past the whole view in one step.
  let shows: boolean | null = null
  let notBelow: boolean | null = null
  let place: BotItemNeedsYouPlace = 'undrawn'
  let jump: BotItemNeedsYouJumpState = { opened: 0, jumped: false, pending: false }
  let reveal: ((node: HTMLElement) => void) | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((listener) => listener())
  const setPlace = (next: BotItemNeedsYouPlace): void => {
    if (next !== place) {
      place = next
      emit()
    }
  }
  const setJump = (next: Partial<BotItemNeedsYouJumpState>): void => {
    jump = { ...jump, ...next }
    emit()
  }
  const settle = (): void =>
    setPlace(
      shows === null || notBelow === null ? null : shows ? 'visible' : notBelow ? 'above' : 'below'
    )
  const observe = (): void => {
    observers.forEach((observer) => observer.disconnect())
    observers = []
    shows = null
    notBelow = null
    if (!node || !root || typeof IntersectionObserver === 'undefined') {
      setPlace(node ? null : 'undrawn')
      return
    }
    const edge = node.querySelector(`[${BOT_ITEM_NEEDS_YOU_TOP_ATTRIBUTE}]`) ?? node
    const watchEdge = (margin: string, read: (entry: IntersectionObserverEntry) => void): void => {
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1)
          if (entry && observers.includes(observer)) {
            read(entry)
            settle()
          }
        },
        { root, rootMargin: margin, threshold: VISIBLE_RATIO }
      )
      observer.observe(edge)
      observers.push(observer)
    }
    watchEdge(`0px 0px -${BOTTOM_EDGE}px 0px`, (entry) => {
      shows = entry.intersectionRatio >= VISIBLE_RATIO
    })
    watchEdge(`${FAR}px 0px -${BOTTOM_EDGE}px 0px`, (entry) => {
      notBelow = entry.intersectionRatio >= VISIBLE_RATIO
    })
  }
  return {
    /** The marked entry, as its ref; a pending jump goes there as soon as it draws. */
    setNode: (next: HTMLElement | null): void => {
      if (next === node) {
        return
      }
      node = next
      observe()
      if (node && jump.pending) {
        setJump({ pending: false })
        reveal?.(node)
      }
    },
    setRoot: (next: HTMLElement | null): void => {
      if (next !== root) {
        root = next
        observe()
      }
    },
    setReveal: (next: (node: HTMLElement) => void): void => {
      reveal = next
    },
    node: (): HTMLElement | null => node,
    place: (): BotItemNeedsYouPlace => place,
    jump: (): BotItemNeedsYouJumpState => jump,
    revealed: (): void => setJump({ opened: jump.opened + 1, jumped: true }),
    wait: (): void => setJump({ pending: true }),
    cancel: (): void => {
      if (jump.pending) {
        setJump({ pending: false })
      }
    },
    forget: (): void => {
      if (jump.jumped || jump.pending) {
        setJump({ jumped: false, pending: false })
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: (): void => {
      observers.forEach((observer) => observer.disconnect())
      observers = []
    }
  }
}
