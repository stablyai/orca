// Scrolling a transcript element to the top of the viewport, and knowing while
// that scroll is still travelling: rows it passes resize under it, so nothing
// short of the view reaching its target says the jump is over.

import { useCallback, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

/** How close to its target a jump counts as arrived: sub-pixel and zoom rounding. */
const ALIGN_ARRIVED_PX = 2

/** Distance from a container's scroll origin down to a descendant, in the
 *  container's own scroll pixels, or null when there is no chain to walk.
 *  Absolutely positioned windowed rows are placed with `top`, never a transform,
 *  so `offsetTop` stays true through the window as well. */
export function nativeChatScrollOffsetWithin(
  element: HTMLElement,
  container: HTMLElement
): number | null {
  let top = 0
  let node: HTMLElement | null = element
  while (node !== null && node !== container) {
    top += node.offsetTop
    // A DOM without layout has no `offsetParent` at all; that ends the chain
    // rather than walking into nothing, and the caller reads the null as
    // "cannot place this yet".
    const parent = node.offsetParent as HTMLElement | null | undefined
    node = parent && typeof parent.offsetTop === 'number' ? parent : null
  }
  return node === container ? top : null
}

/** Fallback when layout provides no offset-parent chain. */
function rectOffsetWithin(element: HTMLElement, container: HTMLElement): number {
  return (
    container.scrollTop +
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top
  )
}

export function useNativeChatViewportAlign({
  scrollRef,
  virtualizer,
  finishReaderTakeover,
  programmaticScrollMarks
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  finishReaderTakeover: () => void
  programmaticScrollMarks: ProgrammaticScrollMarks
}): {
  alignToViewportTop: (element: HTMLElement) => void
  isAlignPending: () => boolean
  /** Another write, or the reader, took the scroll. */
  endAlign: () => void
  /** Whether the view is still the jump's: travelling, or resting where it landed. */
  isAlignHeld: () => boolean
} {
  const alignBehavior = usePrefersReducedMotion() ? 'auto' : 'smooth'
  /** The row or offset `alignToViewportTop` scrolled to, until something else takes the scroll. */
  const alignRef = useRef<(({ index: number } | { offset: number }) & { arrived: boolean }) | null>(
    null
  )

  const alignToViewportTop = useCallback(
    (element: HTMLElement) => {
      const container = scrollRef.current
      if (!container) {
        return
      }
      finishReaderTakeover()
      const index = Number.parseInt(element.dataset.index ?? '', 10)
      // Through the virtualizer so a scroll it is still reconciling — the jump
      // that mounted this row in the first place — is replaced rather than raced.
      if (virtualizer.scrollElement && !Number.isNaN(index)) {
        // By index for a row: rows measured on the way move the target, and the
        // virtualizer re-aims at an index where a fixed offset would land beside it.
        alignRef.current = { index, arrived: false }
        virtualizer.scrollToIndex(index, { align: 'start', behavior: alignBehavior })
        return
      }
      const top =
        nativeChatScrollOffsetWithin(element, container) ?? rectOffsetWithin(element, container)
      alignRef.current = { offset: top, arrived: false }
      if (virtualizer.scrollElement) {
        virtualizer.scrollToOffset(top, { align: 'start', behavior: alignBehavior })
        return
      }
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const landing = Math.max(0, Math.min(top, max))
      if (container.scrollTop !== landing) {
        programmaticScrollMarks.mark(landing)
      }
      container.scrollTo({ top, behavior: alignBehavior })
    },
    [alignBehavior, finishReaderTakeover, programmaticScrollMarks, scrollRef, virtualizer]
  )

  // Read from where the view is, not from a landing event: a stale mark or a
  // scroll end left by an earlier write can precede the jump's first frame.
  const isAlignPending = useCallback(() => {
    const pending = alignRef.current
    const container = scrollRef.current
    if (pending === null || pending.arrived || !container) {
      return false
    }
    const target =
      'index' in pending
        ? virtualizer.getOffsetForIndex(pending.index, 'start')?.[0]
        : pending.offset
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    if (
      target === undefined ||
      Math.abs(container.scrollTop - Math.min(target, max)) <= ALIGN_ARRIVED_PX
    ) {
      pending.arrived = true
      return false
    }
    return true
  }, [scrollRef, virtualizer])

  const endAlign = useCallback(() => {
    alignRef.current = null
  }, [])
  const isAlignHeld = useCallback(() => alignRef.current !== null, [])

  return { alignToViewportTop, isAlignPending, endAlign, isAlignHeld }
}
