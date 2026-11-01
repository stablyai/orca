// Instant jumps still settle as virtualized rows are measured; retain the target until arrival.

import { useCallback, useRef } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'

/** How close to its target a jump counts as arrived: sub-pixel and zoom rounding. */
export const ALIGN_ARRIVED_PX = 2

/** Sum container-relative offsetTop; rows use top positioning so offsets remain valid through virtualization. Null without an offset-parent chain. */
export function nativeChatScrollOffsetWithin(
  element: HTMLElement,
  container: HTMLElement
): number | null {
  let top = 0
  let node: HTMLElement | null = element
  while (node !== null && node !== container) {
    top += node.offsetTop
    // DOM without layout has no offsetParent; return null so callers defer placement.
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
  /** Whether the view is still the jump's: settling, or resting where it landed. */
  isAlignHeld: () => boolean
} {
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
      // Use the virtualizer to replace its pending jump reconciliation instead of racing it.
      if (virtualizer.scrollElement && !Number.isNaN(index)) {
        // Target the row's index so measurements can correct its landing offset.
        alignRef.current = { index, arrived: false }
        virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' })
        return
      }
      const top =
        nativeChatScrollOffsetWithin(element, container) ?? rectOffsetWithin(element, container)
      alignRef.current = { offset: top, arrived: false }
      if (virtualizer.scrollElement) {
        virtualizer.scrollToOffset(top, { align: 'start', behavior: 'auto' })
        return
      }
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const landing = Math.max(0, Math.min(top, max))
      if (container.scrollTop !== landing) {
        programmaticScrollMarks.mark(landing)
      }
      container.scrollTo({ top, behavior: 'auto' })
    },
    [finishReaderTakeover, programmaticScrollMarks, scrollRef, virtualizer]
  )

  // Read actual geometry; stale scroll marks/end events can precede the jump’s first frame.
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
