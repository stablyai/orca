import { elementScroll, observeElementOffset, type Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'

type SidebarVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>
type ScrollOptions = Parameters<typeof elementScroll>[1]

export function createSidebarSmoothReveal(args: {
  marks: ProgrammaticScrollMarks
  onRetired: () => void
}) {
  let owned: { target: number } | null = null
  let retirement: 'abort' | 'settled' | null = null

  const retire = (instance: SidebarVirtualizer, offset: number, abort: boolean) => {
    if (!owned) {
      return
    }
    owned = null
    retirement = abort ? 'abort' : 'settled'
    try {
      // Replace the library operation at the live position without clamp/layout reads.
      instance.scrollBy(offset - (instance.scrollOffset ?? offset), { behavior: 'auto' })
    } finally {
      retirement = null
    }
    args.onRetired()
  }

  const scrollTo = (offset: number, options: ScrollOptions, instance: SidebarVirtualizer) => {
    if (retirement) {
      if (retirement === 'abort') {
        elementScroll(offset, options, instance)
      }
      return
    }
    const element = instance.scrollElement
    const target = offset + (options.adjustments ?? 0)
    if (options.behavior === 'smooth' && element) {
      owned = { target }
      if (target === element.scrollTop) {
        retire(instance, target, false)
        return
      }
    } else if (options.behavior !== undefined && owned) {
      owned = null
      args.onRetired()
    }
    if (element?.scrollTop !== target) {
      args.marks.mark(target)
    }
    elementScroll(offset, options, instance)
  }

  const observeOffset = (
    instance: SidebarVirtualizer,
    callback: (offset: number, isScrolling: boolean) => void
  ) => {
    const element = instance.scrollElement
    const onTakeover = (event: Event) => {
      if (
        owned &&
        event instanceof CustomEvent &&
        event.detail?.cancelRestore === true &&
        element
      ) {
        retire(instance, element.scrollTop, true)
      }
    }
    element?.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, onTakeover)
    const cleanup = observeElementOffset(instance, (offset, isScrolling) => {
      const observed = owned
      callback(offset, isScrolling)
      if (
        observed &&
        owned === observed &&
        (!isScrolling || Math.abs(offset - observed.target) < 1)
      ) {
        retire(instance, offset, false)
      }
    })
    return () => {
      owned = null
      element?.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, onTakeover)
      cleanup?.()
    }
  }

  return { scrollTo, observeOffset }
}
