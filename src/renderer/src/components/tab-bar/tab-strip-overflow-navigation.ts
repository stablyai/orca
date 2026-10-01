import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'
import {
  computeTabStripScrollMetrics,
  sameTabStripScrollMetrics,
  type TabStripScrollMetrics
} from './tab-strip-scroll-metrics'
import { isTabStripPointerGestureActive } from './tab-strip-pointer-gesture'
import {
  captureTabStripScrollAnchor,
  isLastTabStripTab,
  restoreTabStripScrollAnchor,
  type TabStripScrollAnchor
} from './tab-strip-scroll-anchor'
import {
  findOffscreenOpenedTabStripSlot,
  findTabStripSlot,
  getActiveTabDockSide,
  readTabStripSlotIds,
  revealTabStripSlot,
  type ActiveTabDockSide
} from './tab-strip-slot-geometry'
import { useTabStripCloseSpacer } from './use-tab-strip-close-spacer'
import { isTabStripScrolledToEnd, scrollTabStripByStep } from './tab-strip-scroll-step'

const EMPTY_TAB_STRIP_OVERFLOW_STATE: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0
}

export function useTabStripOverflowNavigation({
  activeVisibleTabId,
  activeDockSlotId,
  layoutKey,
  worktreeId
}: {
  activeVisibleTabId: string | null
  /** The slot drawn active; a client-hosted row can take it without `activeVisibleTabId` changing. */
  activeDockSlotId: string | null
  layoutKey: string
  worktreeId: string
}): {
  tabStripRef: RefObject<HTMLDivElement | null>
  tabStripOverflowState: TabStripScrollMetrics
  activeTabDockSide: ActiveTabDockSide | null
  closeSpacerRef: RefObject<HTMLDivElement | null>
  scrollTabStrip: (direction: 'start' | 'end', behavior?: ScrollBehavior) => void
} {
  const tabStripRef = useRef<HTMLDivElement>(null)
  const prevStripRef = useRef<{ worktreeId: string; tabIds: ReadonlySet<string> } | null>(null)
  const stickToEndRef = useRef(false)
  const tabClosedThisCommitRef = useRef(false)
  const activeTabIdRef = useRef<string | null>(null)
  const hoverDeferredRevealIdsRef = useRef<Set<string>>(new Set())
  const scrollAnchorRef = useRef<{
    activeTabId: string | null
    anchor: TabStripScrollAnchor | null
  } | null>(null)
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripScrollMetrics>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const [activeTabDockSide, setActiveTabDockSide] = useState<ActiveTabDockSide | null>(null)
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = computeTabStripScrollMetrics(el)
    setTabStripOverflowState((previous) =>
      sameTabStripScrollMetrics(previous, next) ? previous : next
    )
    setActiveTabDockSide(getActiveTabDockSide(el))
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
  const recordScrollAnchor = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const activeTabId = activeTabIdRef.current
    scrollAnchorRef.current = { activeTabId, anchor: captureTabStripScrollAnchor(el, activeTabId) }
  }, [])
  const settleAfterCloseSpacer = useCallback((): void => {
    const el = tabStripRef.current
    if (el) {
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      // Why flushSync: release comes from native events that render late, so the scroll arrows
      // would drop a frame after the tabs regrow and the strip would settle in two steps.
      flushSync(updateTabStripOverflowState)
      recordScrollAnchor()
    }
  }, [recordScrollAnchor, updateTabStripOverflowState])
  const {
    closeSpacerRef,
    recordStripExtent,
    holdStripAfterClose,
    shrinkCloseSpacer,
    releaseCloseSpacer
  } = useTabStripCloseSpacer(tabStripRef, settleAfterCloseSpacer)

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
    const onScroll = (): void => {
      // Only keep sticking while the user hasn't intentionally scrolled away.
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      updateTabStripOverflowState()
      recordScrollAnchor()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    const handleStripResize = (): void => {
      updateTabStripOverflowState()
      // If the user is pinned to the right edge, keep it pinned even as tab
      // labels (e.g. "Terminal 5" -> branch name) expand and change scrollWidth.
      if (stickToEndRef.current && !isTabStripPointerGestureActive()) {
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      }
      recordScrollAnchor()
      recordStripExtent(el)
    }

    const disconnectResizeObservers = bindTabStripContentResizeObservers(el, handleStripResize)

    return () => {
      el.removeEventListener('scroll', onScroll)
      disconnectResizeObservers()
    }
  }, [recordScrollAnchor, recordStripExtent, updateTabStripOverflowState])

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onPointerLeave = (): void => {
      const deferred = hoverDeferredRevealIdsRef.current
      if (deferred.size === 0) {
        return
      }
      hoverDeferredRevealIdsRef.current = new Set()
      if (isTabStripPointerGestureActive()) {
        return
      }
      const knownIds = new Set([...readTabStripSlotIds(el)].filter((id) => !deferred.has(id)))
      const offscreenOpened = findOffscreenOpenedTabStripSlot(el, knownIds)
      if (!offscreenOpened) {
        return
      }
      revealTabStripSlot(el, offscreenOpened)
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      updateTabStripOverflowState()
      recordScrollAnchor()
    }
    // Why the wrapper, registered after the close spacer's: the reveal must measure the strip
    // once the spacer is gone, and the scroll thumb overlay is not a way out of the strip.
    const wrapper = el.parentElement ?? el
    wrapper.addEventListener('pointerleave', onPointerLeave)
    return () => wrapper.removeEventListener('pointerleave', onPointerLeave)
  }, [recordScrollAnchor, updateTabStripOverflowState])

  // Why a ref set first: the growth effect below must see this commit's active tab without re-running on every tab switch.
  useLayoutEffect(() => {
    activeTabIdRef.current = activeVisibleTabId
  }, [activeVisibleTabId])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      prevStripRef.current = null
      return
    }
    const prev = prevStripRef.current
    const tabIds = readTabStripSlotIds(strip)
    prevStripRef.current = { worktreeId, tabIds }
    if (!prev || prev.worktreeId !== worktreeId) {
      hoverDeferredRevealIdsRef.current = new Set()
      releaseCloseSpacer()
      updateTabStripOverflowState()
      recordStripExtent(strip)
      return
    }
    const pointerGestureActive = isTabStripPointerGestureActive()
    // Why identities, not a count: a tab that replaces another opens without the strip growing.
    const openedIds = new Set([...tabIds].filter((id) => !prev.tabIds.has(id)))
    const closedIds = [...prev.tabIds].filter((id) => !tabIds.has(id))
    const tabOpened = openedIds.size > 0
    tabClosedThisCommitRef.current = !tabOpened && closedIds.length > 0
    if (tabOpened) {
      shrinkCloseSpacer(strip, openedIds)
    } else if (closedIds.length > 0) {
      holdStripAfterClose(strip, closedIds)
    }
    const scrollToEnd = (stick: boolean): void => {
      const el = tabStripRef.current
      if (!el) {
        return
      }
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      if (stick) {
        stickToEndRef.current = true
      }
      updateTabStripOverflowState()
    }
    const recorded = scrollAnchorRef.current
    if (tabOpened && !pointerGestureActive) {
      if (recorded?.activeTabId === activeTabIdRef.current) {
        // Why: insertions around the viewed tab keep its on-screen x, the way VS Code and Chrome
        // leave it still; only a tab that lands out of view scrolls, and the active tab docks.
        if (recorded.anchor) {
          restoreTabStripScrollAnchor(strip, recorded.anchor)
        }
        // Why wait for the pointer to leave: the tab it is over would slide away before the click lands.
        if (strip.matches(':hover')) {
          for (const id of tabIds) {
            if (!prev.tabIds.has(id)) {
              hoverDeferredRevealIdsRef.current.add(id)
            }
          }
        } else {
          const offscreenOpened = findOffscreenOpenedTabStripSlot(strip, prev.tabIds)
          if (offscreenOpened) {
            revealTabStripSlot(strip, offscreenOpened)
          }
        }
        stickToEndRef.current = isTabStripScrolledToEnd(strip)
      } else if (isLastTabStripTab(strip, activeTabIdRef.current)) {
        scrollToEnd(true)
        requestAnimationFrame(() => scrollToEnd(true))
      }
      // A foreground tab opened mid-strip is revealed by the active-tab effect below.
    } else if (stickToEndRef.current && !pointerGestureActive) {
      scrollToEnd(false)
      // Why re-check: a reveal later in this commit may have scrolled away from the end.
      requestAnimationFrame(() => {
        if (stickToEndRef.current) {
          scrollToEnd(false)
        }
      })
    }
    updateTabStripOverflowState()
    requestAnimationFrame(updateTabStripOverflowState)
    recordScrollAnchor()
    recordStripExtent(strip)
  }, [
    holdStripAfterClose,
    layoutKey,
    recordScrollAnchor,
    recordStripExtent,
    releaseCloseSpacer,
    shrinkCloseSpacer,
    updateTabStripOverflowState,
    worktreeId
  ])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip || !activeVisibleTabId) {
      recordScrollAnchor()
      return
    }
    const activeSlot = findTabStripSlot(strip, activeVisibleTabId)
    if (!activeSlot) {
      recordScrollAnchor()
      return
    }
    // Why hold still: active-tab preview changes during a tab press must not move the strip under
    // a stationary pointer before the release decides click/drag. After a close, the next tab can
    // be far back in recent history; chasing it throws the strip around, and it docks into view.
    if (isTabStripPointerGestureActive() || tabClosedThisCommitRef.current) {
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      return
    }
    revealTabStripSlot(strip, activeSlot)
    // Why: the scroll event lands after the resize observer, which would re-pin a stale end stick over this reveal.
    stickToEndRef.current = isTabStripScrolledToEnd(strip)
    requestAnimationFrame(updateTabStripOverflowState)
    recordScrollAnchor()
  }, [activeVisibleTabId, recordScrollAnchor, updateTabStripOverflowState])

  // Why: moving the dock between slots shifts which edge it is drawn at with no scroll or resize.
  useLayoutEffect(() => {
    updateTabStripOverflowState()
  }, [activeDockSlotId, updateTabStripOverflowState])

  // Why every render: the close flag belongs to the commit that set it, not a later tab switch.
  useLayoutEffect(() => {
    tabClosedThisCommitRef.current = false
  })

  return { tabStripRef, tabStripOverflowState, activeTabDockSide, closeSpacerRef, scrollTabStrip }
}
