import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'
import {
  computeTabStripScrollMetrics,
  sameTabStripScrollMetrics,
  type TabStripScrollMetrics
} from './tab-strip-scroll-metrics'

const TAB_STRIP_SCROLL_FRACTION = 0.75
const TAB_STRIP_MIN_SCROLL_STEP_PX = 120

export function scrollTabStripByStep(
  el: HTMLElement,
  direction: 'start' | 'end',
  behavior: ScrollBehavior = 'smooth'
): void {
  const scrollStep = Math.max(
    TAB_STRIP_MIN_SCROLL_STEP_PX,
    el.clientWidth * TAB_STRIP_SCROLL_FRACTION
  )
  el.scrollBy({
    left: direction === 'start' ? -scrollStep : scrollStep,
    behavior
  })
}

const EMPTY_TAB_STRIP_OVERFLOW_STATE: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0
}

export function useTabStripOverflowNavigation({
  activeVisibleTabId,
  layoutKey,
  tabCount,
  worktreeId
}: {
  activeVisibleTabId: string | null
  layoutKey: string
  tabCount: number
  worktreeId: string
}): {
  tabStripRef: RefObject<HTMLDivElement | null>
  tabStripOverflowState: TabStripScrollMetrics
  scrollTabStrip: (direction: 'start' | 'end', behavior?: ScrollBehavior) => void
} {
  const tabStripRef = useRef<HTMLDivElement>(null)
  const prevStripLenRef = useRef<{ worktreeId: string; len: number } | null>(null)
  const stickToEndRef = useRef(false)
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripScrollMetrics>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = computeTabStripScrollMetrics(el)
    setTabStripOverflowState((previous) =>
      sameTabStripScrollMetrics(previous, next) ? previous : next
    )
  }, [])
  const scrollTabStrip = useCallback(
    (direction: 'start' | 'end', behavior: ScrollBehavior = 'smooth'): void => {
      const el = tabStripRef.current
      if (!el) {
        return
      }
      scrollTabStripByStep(el, direction, behavior)
    },
    []
  )

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
        updateTabStripOverflowState()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [updateTabStripOverflowState])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const isAtEnd = (): boolean => {
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      return el.scrollLeft >= max - 2
    }
    const onScroll = (): void => {
      // Only keep sticking while the user hasn't intentionally scrolled away.
      stickToEndRef.current = isAtEnd()
      updateTabStripOverflowState()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    const handleStripResize = (): void => {
      updateTabStripOverflowState()
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. "Terminal 5" -> branch name) expand and change scrollWidth.
      if (!stickToEndRef.current) {
        return
      }
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    }

    const disconnectResizeObservers = bindTabStripContentResizeObservers(el, handleStripResize)

    return () => {
      el.removeEventListener('scroll', onScroll)
      disconnectResizeObservers()
    }
  }, [updateTabStripOverflowState])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    const prev = prevStripLenRef.current
    if (!strip) {
      prevStripLenRef.current = { worktreeId, len: tabCount }
      return
    }
    if (!prev || prev.worktreeId !== worktreeId) {
      prevStripLenRef.current = { worktreeId, len: tabCount }
      updateTabStripOverflowState()
      return
    }
    if (stickToEndRef.current) {
      const scrollToEnd = (): void => {
        const el = tabStripRef.current
        if (!el) {
          return
        }
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        updateTabStripOverflowState()
      }
      scrollToEnd()
      requestAnimationFrame(scrollToEnd)
    }
    if (tabCount > prev.len) {
      const scrollToEnd = (): void => {
        const el = tabStripRef.current
        if (!el) {
          return
        }
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        stickToEndRef.current = true
        updateTabStripOverflowState()
      }
      scrollToEnd()
      requestAnimationFrame(scrollToEnd)
    }
    prevStripLenRef.current = { worktreeId, len: tabCount }
    updateTabStripOverflowState()
    requestAnimationFrame(updateTabStripOverflowState)
  }, [layoutKey, tabCount, updateTabStripOverflowState, worktreeId])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip || !activeVisibleTabId) {
      return
    }
    const activeTab = strip.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeVisibleTabId)}"]`
    )
    if (!activeTab) {
      return
    }
    activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    requestAnimationFrame(updateTabStripOverflowState)
  }, [activeVisibleTabId, updateTabStripOverflowState])

  return { tabStripRef, tabStripOverflowState, scrollTabStrip }
}
