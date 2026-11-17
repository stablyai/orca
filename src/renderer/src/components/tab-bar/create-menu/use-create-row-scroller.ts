import { useEffect, useRef, useState } from 'react'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import { bindTabStripContentResizeObservers } from '../strip/tab-strip-content-resize-observers'
import {
  EMPTY_TAB_STRIP_OVERFLOW_STATE,
  computeTabStripOverflowState,
  sameTabStripOverflowState,
  scrollStripSidewaysOnWheel
} from '../strip/tab-strip-scroll-metrics'

/** Horizontal scrolling for the create row's icons once they outgrow the menu width. */
export function useCreateRowScroller() {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState(EMPTY_TAB_STRIP_OVERFLOW_STATE)

  // Track the strip's size, children, and scroll position while it is mounted.
  useEffect(() => {
    if (!scroller) {
      return
    }
    const sync = (): void => {
      const next = computeTabStripOverflowState(scroller)
      setOverflow((current) => (sameTabStripOverflowState(current, next) ? current : next))
    }
    const onWheel = (event: WheelEvent): void => {
      // Only while overflowing, so a short row never swallows the menu's own scrolling.
      if (scroller.scrollWidth > scroller.clientWidth) {
        scrollStripSidewaysOnWheel(scroller, event)
      }
    }
    sync()
    const unbindResize = bindTabStripContentResizeObservers(scroller, sync)
    scroller.addEventListener('scroll', sync, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      unbindResize()
      scroller.removeEventListener('scroll', sync)
      scroller.removeEventListener('wheel', onWheel)
    }
  }, [scroller])

  return {
    scrollerRef,
    scroller,
    overflow,
    attachScroller: (node: HTMLDivElement | null): void => {
      scrollerRef.current = node
      setScroller(node)
    },
    revealIcon: (index: number): void => {
      scrollerRef.current?.children.item(index)?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: motionSafeScrollBehavior()
      })
    }
  }
}
