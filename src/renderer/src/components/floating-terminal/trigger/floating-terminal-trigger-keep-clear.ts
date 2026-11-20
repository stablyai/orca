// Page parts the floating terminal button must never cover, such as the item page's comment box. The button
// gets out of their way by showing just below or above them, so pages never reserve space for it.
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import type { FloatingTerminalTriggerKeepClearRect } from './floating-terminal-trigger-position'

const NONE: readonly FloatingTerminalTriggerKeepClearRect[] = []
type Registration = {
  /** The column the element sits in, whose bottom bounds where the button may go below it. */
  column: HTMLElement | null
  /** Watches `column` instead, when the element's column changes. */
  watch: (column: HTMLElement | null) => void
}

const elements = new Map<HTMLElement, Registration>()
const listeners = new Set<() => void>()
let rects = NONE

function measure(): void {
  const next: FloatingTerminalTriggerKeepClearRect[] = []
  for (const [element, registration] of elements) {
    const { left, top, right, bottom } = element.getBoundingClientRect()
    // A hidden page's box measures empty and has nothing to keep clear.
    if (right > left && bottom > top) {
      // Resolved again each time: a wrapper hidden at registration lays nothing out once shown.
      const column = layoutParentOf(element)
      if (column !== registration.column) {
        registration.watch(column)
      }
      const paneBottom = column?.getBoundingClientRect().bottom ?? window.innerHeight
      next.push({ left, top, right, bottom, paneBottom })
    }
  }
  const same =
    next.length === rects.length &&
    next.every(
      (rect, index) =>
        rect.left === rects[index].left &&
        rect.top === rects[index].top &&
        rect.right === rects[index].right &&
        rect.bottom === rects[index].bottom &&
        rect.paneBottom === rects[index].paneBottom
    )
  if (same) {
    return
  }
  rects = next.length > 0 ? next : NONE
  for (const listener of listeners) {
    listener()
  }
}

/** The element that lays `element` out: past `display: contents` wrappers, which have no box to watch. */
function layoutParentOf(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent && getComputedStyle(parent).display === 'contents') {
    parent = parent.parentElement
  }
  return parent
}

function keepClearOf(element: HTMLElement): () => void {
  if (elements.size === 0) {
    window.addEventListener('resize', measure)
  }
  // The element also moves without resizing when a box above it in its column grows, e.g. Activity
  // filling in, so the column and every box in it are watched, including boxes added later.
  const resized = new ResizeObserver(measure)
  const added = new MutationObserver(() => {
    registration.watch(registration.column)
    measure()
  })
  const registration: Registration = {
    column: null,
    watch: (column) => {
      registration.column = column
      resized.disconnect()
      added.disconnect()
      resized.observe(element)
      if (column) {
        for (const box of [column, ...column.children]) {
          resized.observe(box)
        }
        added.observe(column, { childList: true })
      }
    }
  }
  registration.watch(layoutParentOf(element))
  elements.set(element, registration)
  measure()
  return () => {
    resized.disconnect()
    added.disconnect()
    elements.delete(element)
    if (elements.size === 0) {
      window.removeEventListener('resize', measure)
    }
    measure()
  }
}

/** Keeps the floating terminal button off `element` while it is mounted. */
export function useKeepFloatingTerminalTriggerClear(element: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = element.current
    return node ? keepClearOf(node) : undefined
  }, [element])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFloatingTerminalTriggerKeepClearRects(): readonly FloatingTerminalTriggerKeepClearRect[] {
  return useSyncExternalStore(
    subscribe,
    () => rects,
    () => NONE
  )
}
