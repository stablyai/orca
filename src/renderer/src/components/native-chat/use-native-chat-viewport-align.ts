// Instant jumps still settle as virtualized rows are measured; retain the target until arrival.

import { useCallback, useRef } from 'react'
import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'
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

export type NativeChatAlignEdge = 'start' | 'end'

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
  /** `end` brings the row's end to the viewport's bottom instead, for the newest of a run. */
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  isAlignPending: () => boolean
  /** Another write, or the reader, took the scroll. */
  endAlign: () => void
  /** Whether the view is still the jump's: settling, or resting where it landed. */
  isAlignHeld: () => boolean
  /**
   * Whether a resize of the row at this index moves an end-aligned jump's row: that row or any
   * above it, visible or not. The row is held by key, so rows inserted or removed before it
   * don't retarget the hold; once it is no longer drawn the hold ends.
   */
  pinsEndGrowth: (index: number, measurements: readonly VirtualItem[]) => boolean
  /** A reader acting on the content owns what it moves: an end-aligned jump stops holding its row. */
  releaseEndPin: () => void
} {
  /** The row or offset `alignToViewportTop` scrolled to, until something else takes the scroll. */
  const alignRef = useRef<
    | ((
        | { index: number; edge: NativeChatAlignEdge; key: VirtualItem['key'] }
        | { offset: number }
      ) & {
        arrived: boolean
      })
    | null
  >(null)

  const alignToViewportTop = useCallback(
    (element: HTMLElement, edge: NativeChatAlignEdge = 'start') => {
      const container = scrollRef.current
      if (!container) {
        return
      }
      finishReaderTakeover()
      const index = Number.parseInt(element.dataset.index ?? '', 10)
      // Use the virtualizer to replace its pending jump reconciliation instead of racing it.
      if (virtualizer.scrollElement && !Number.isNaN(index)) {
        // Target the row's index so measurements can correct its landing offset.
        alignRef.current = {
          index,
          edge,
          key: virtualizer.options.getItemKey(index),
          arrived: false
        }
        virtualizer.scrollToIndex(index, { align: edge, behavior: 'auto' })
        return
      }
      const start =
        nativeChatScrollOffsetWithin(element, container) ?? rectOffsetWithin(element, container)
      const top =
        edge === 'end' ? Math.max(0, start + element.offsetHeight - container.clientHeight) : start
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
        ? virtualizer.getOffsetForIndex(pending.index, pending.edge)?.[0]
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
  const pinsEndGrowth = useCallback((index: number, measurements: readonly VirtualItem[]) => {
    const held = alignRef.current
    if (held === null || !('index' in held) || held.edge !== 'end') {
      return false
    }
    // One read while the row stays put; scan only after rows were inserted or removed before it.
    if (measurements[held.index]?.key !== held.key) {
      const moved = measurements.findIndex((item) => item.key === held.key)
      if (moved === -1) {
        alignRef.current = null
        return false
      }
      held.index = moved
    }
    return index <= held.index
  }, [])
  const releaseEndPin = useCallback(() => {
    const held = alignRef.current
    if (held !== null && 'index' in held && held.edge === 'end') {
      alignRef.current = null
      // The virtualizer keeps reconciling its index target while the row grows; rebase it here.
      const container = scrollRef.current
      if (container && virtualizer.scrollElement) {
        virtualizer.scrollToOffset(container.scrollTop, { behavior: 'auto' })
      }
    }
  }, [scrollRef, virtualizer])

  return {
    alignToViewportTop,
    isAlignPending,
    endAlign,
    isAlignHeld,
    pinsEndGrowth,
    releaseEndPin
  }
}
