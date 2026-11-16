import { useEffect, useRef, useState } from 'react'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import {
  computeTabStripOverflowState,
  sameTabStripOverflowState,
  type TabStripOverflowState
} from './tab-strip-scroll-metrics'

const NO_OVERFLOW: TabStripOverflowState = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false
}

/** Horizontal scrolling for the create row's icons once they outgrow the menu width. */
export function useCreateRowScroller(): {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  attachScroller: (node: HTMLDivElement | null) => void
  overflow: TabStripOverflowState
  revealIcon: (index: number) => void
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState(NO_OVERFLOW)

  // Subscribe to the strip's size, children, and scroll position while it is mounted.
  useEffect(() => {
    if (!scroller) {
      return
    }
    const sync = (): void => {
      const next = computeTabStripOverflowState(scroller)
      setOverflow((current) => (sameTabStripOverflowState(current, next) ? current : next))
    }
    // Why: a mouse wheel only scrolls vertically; turn it sideways while the icons overflow.
    const scrollSideways = (event: WheelEvent): void => {
      if (
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        scroller.scrollWidth <= scroller.clientWidth
      ) {
        return
      }
      event.preventDefault()
      scroller.scrollLeft += event.deltaY
    }
    sync()
    const resizeObserver = new ResizeObserver(sync)
    resizeObserver.observe(scroller)
    const childObserver = new MutationObserver(sync)
    childObserver.observe(scroller, { childList: true })
    scroller.addEventListener('scroll', sync, { passive: true })
    scroller.addEventListener('wheel', scrollSideways, { passive: false })
    return () => {
      resizeObserver.disconnect()
      childObserver.disconnect()
      scroller.removeEventListener('scroll', sync)
      scroller.removeEventListener('wheel', scrollSideways)
    }
  }, [scroller])

  const attachScroller = (node: HTMLDivElement | null): void => {
    scrollerRef.current = node
    setScroller(node)
  }
  const revealIcon = (index: number): void => {
    scrollerRef.current?.children.item(index)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: motionSafeScrollBehavior()
    })
  }

  return { scrollerRef, attachScroller, overflow, revealIcon }
}
