// Page parts the floating terminal button must never cover, such as the item page's comment box. The button
// gets out of their way by showing just above them, so pages never reserve space for it.
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import type { FloatingTerminalTriggerKeepClearRect } from './floating-terminal-trigger-position'

const NONE: readonly FloatingTerminalTriggerKeepClearRect[] = []
const elements = new Set<HTMLElement>()
const listeners = new Set<() => void>()
let rects = NONE
let observer: ResizeObserver | null = null

function measure(): void {
  const next: FloatingTerminalTriggerKeepClearRect[] = []
  for (const element of elements) {
    const { left, top, right, bottom } = element.getBoundingClientRect()
    // A hidden page's box measures empty and has nothing to keep clear.
    if (right > left && bottom > top) {
      next.push({ left, top, right, bottom })
    }
  }
  const same =
    next.length === rects.length &&
    next.every(
      (rect, index) =>
        rect.left === rects[index].left &&
        rect.top === rects[index].top &&
        rect.right === rects[index].right &&
        rect.bottom === rects[index].bottom
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
  if (!observer) {
    observer = new ResizeObserver(measure)
    window.addEventListener('resize', measure)
  }
  elements.add(element)
  observer.observe(element)
  // The parent resizes when the page moves the element without resizing it, e.g. a taller pane.
  const parent = layoutParentOf(element)
  if (parent) {
    observer.observe(parent)
  }
  measure()
  return () => {
    elements.delete(element)
    if (elements.size === 0 && observer) {
      observer.disconnect()
      observer = null
      window.removeEventListener('resize', measure)
    } else if (observer) {
      observer.unobserve(element)
      if (parent && ![...elements].some((other) => layoutParentOf(other) === parent)) {
        observer.unobserve(parent)
      }
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
