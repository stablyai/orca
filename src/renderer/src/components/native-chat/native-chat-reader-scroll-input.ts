// Reader-initiated scrolling, told apart by its input rather than by scroll events:
// a smooth programmatic scroll's own frames arrive as unmarked scroll events too.

import type React from 'react'

const READER_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' '
])

function isEditableTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  )
}

export type NativeChatReaderScrollInputHandlers = Pick<
  React.HTMLAttributes<HTMLDivElement>,
  'onWheel' | 'onTouchMove' | 'onKeyDown' | 'onPointerDown'
>

/** Scroller props that call `onReaderScroll` on a wheel, touch drag, scroll key or
 *  scrollbar grab. */
export function nativeChatReaderScrollInputHandlers(
  onReaderScroll: () => void
): NativeChatReaderScrollInputHandlers {
  return {
    onWheel: onReaderScroll,
    onTouchMove: onReaderScroll,
    onKeyDown: (event) => {
      if (READER_SCROLL_KEYS.has(event.key) && !isEditableTarget(event.target)) {
        onReaderScroll()
      }
    },
    // The scrollbar belongs to the scroller itself; a press on its content does not scroll.
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) {
        onReaderScroll()
      }
    }
  }
}
