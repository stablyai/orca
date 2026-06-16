import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const TAB_STRIP_SCROLL_FRACTION = 0.75
const TAB_STRIP_MIN_SCROLL_STEP_PX = 120

type TabStripOverflowState = {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
}

const EMPTY_TAB_STRIP_OVERFLOW_STATE: TabStripOverflowState = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false
}

function readTabStripOverflowState(el: HTMLElement): TabStripOverflowState {
  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const hasOverflow = maxScrollLeft > 1
  return {
    hasOverflow,
    canScrollStart: hasOverflow && el.scrollLeft > 1,
    canScrollEnd: hasOverflow && el.scrollLeft < maxScrollLeft - 1
  }
}

function sameTabStripOverflowState(
  left: TabStripOverflowState,
  right: TabStripOverflowState
): boolean {
  return (
    left.hasOverflow === right.hasOverflow &&
    left.canScrollStart === right.canScrollStart &&
    left.canScrollEnd === right.canScrollEnd
  )
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
  tabStripOverflowState: TabStripOverflowState
  scrollTabStrip: (direction: 'start' | 'end') => void
} {
  const tabStripRef = useRef<HTMLDivElement>(null)
  const prevStripLenRef = useRef<{ worktreeId: string; len: number } | null>(null)
  const stickToEndRef = useRef(false)
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripOverflowState>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = readTabStripOverflowState(el)
    setTabStripOverflowState((previous) =>
      sameTabStripOverflowState(previous, next) ? previous : next
    )
  }, [])
  const scrollTabStrip = useCallback(
    (direction: 'start' | 'end'): void => {
      const el = tabStripRef.current
      if (!el) {
        return
      }
      const scrollStep = Math.max(
        TAB_STRIP_MIN_SCROLL_STEP_PX,
        el.clientWidth * TAB_STRIP_SCROLL_FRACTION
      )
      el.scrollBy({
        left: direction === 'start' ? -scrollStep : scrollStep,
        behavior: 'smooth'
      })
      requestAnimationFrame(updateTabStripOverflowState)
    },
    [updateTabStripOverflowState]
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

    const ro = new ResizeObserver(() => {
      updateTabStripOverflowState()
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. "Terminal 5" -> branch name) expand and change scrollWidth.
      if (!stickToEndRef.current) {
        return
      }
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
    })
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
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
