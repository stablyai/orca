import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { bindTabStripContentResizeObservers } from './tab-strip-content-resize-observers'
import {
  EMPTY_TAB_STRIP_OVERFLOW_STATE,
  computeTabStripOverflowState,
  sameTabStripOverflowState,
  scrollStripSidewaysOnWheel,
  type TabStripOverflowState
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
  getActiveTabDockSide,
  readTabStripSlotIds,
  revealTabStripSlot,
  updateTabStripDockAvailability,
  type ActiveTabDockSide
} from './tab-strip-slot-geometry'
import { useTabDragActive } from '../../tab-group/drag/tab-drag-context'
import {
  notifyTabStripListeners,
  revealFirstUnmountedTabStripSlot,
  useNotifyTabStripScrollAfterCommit,
  useTabStripCommitStartScroll,
  useTabStripListenerSubscribe
} from './tab-strip-window'
import { isTabStripScrolledToEnd, scrollTabStripByStep } from './tab-strip-scroll-controls'
import { useRevealFocusedTabStripSlot } from './use-reveal-focused-tab-strip-slot'

export function useTabStripOverflowNavigation({
  activeVisibleTabId,
  activeDockSlotId,
  isFocused,
  layoutKey,
  slotIds,
  worktreeId
}: {
  activeVisibleTabId: string | null
  /** The slot drawn active; a client-hosted row can take it without `activeVisibleTabId` changing. */
  activeDockSlotId: string | null
  /** When a split gains focus, bring its selected tab back into view. */
  isFocused?: boolean
  layoutKey: string
  /** Every slot in strip order, mounted or not: a windowed strip's DOM holds only part of it. */
  slotIds: readonly string[]
  worktreeId: string
}): {
  tabStripRef: RefObject<HTMLDivElement | null>
  tabStripOverflowState: TabStripOverflowState
  activeTabDockSide: ActiveTabDockSide | null
  scrollTabStrip: (direction: 'start' | 'end', behavior?: ScrollBehavior) => void
  subscribeToStripResize: (listener: () => void) => () => void
} {
  const isTabDragActive = useTabDragActive()
  const tabStripRef = useRef<HTMLDivElement>(null)
  // Why first: this hook's effects below are the ones that scroll the strip.
  const commitStartScrollRef = useTabStripCommitStartScroll(tabStripRef)
  const stripResizeListenersRef = useRef<Set<() => void>>(new Set())
  const subscribeToStripResize = useTabStripListenerSubscribe(stripResizeListenersRef)
  const prevStripRef = useRef<{ worktreeId: string; tabIds: ReadonlySet<string> } | null>(null)
  const stickToEndRef = useRef(false)
  const tabClosedThisCommitRef = useRef(false)
  const tabCloseGenerationRef = useRef(0)
  const activeTabIdRef = useRef<string | null>(null)
  const slotIdsRef = useRef<readonly string[]>(slotIds)
  const hoverDeferredRevealIdsRef = useRef<Set<string>>(new Set())
  const scrollAnchorRef = useRef<{
    activeTabId: string | null
    anchor: TabStripScrollAnchor | null
  } | null>(null)
  // Why no thumb position here: it changes every scroll frame, and every tab would re-render with it.
  const [tabStripOverflowState, setTabStripOverflowState] = useState<TabStripOverflowState>(
    EMPTY_TAB_STRIP_OVERFLOW_STATE
  )
  const [activeTabDockSide, setActiveTabDockSide] = useState<ActiveTabDockSide | null>(null)
  const updateTabStripOverflowState = useCallback((): void => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const next = computeTabStripOverflowState(el)
    setTabStripOverflowState((previous) =>
      sameTabStripOverflowState(previous, next) ? previous : next
    )
    updateTabStripDockAvailability(el)
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

  useEffect(() => {
    const el = tabStripRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent): void => {
      if (scrollStripSidewaysOnWheel(el, e)) {
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
      // Keep end-pinned strips at the right edge as live labels change scrollWidth.
      if (stickToEndRef.current && !isTabStripPointerGestureActive()) {
        el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
      }
      recordScrollAnchor()
      notifyTabStripListeners(stripResizeListenersRef)
    }

    const disconnectResizeObservers = bindTabStripContentResizeObservers(el, handleStripResize)

    return () => {
      el.removeEventListener('scroll', onScroll)
      disconnectResizeObservers()
    }
  }, [recordScrollAnchor, updateTabStripOverflowState])

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
      if (offscreenOpened) {
        revealTabStripSlot(el, offscreenOpened)
      } else if (!revealFirstUnmountedTabStripSlot(el, slotIdsRef.current, deferred)) {
        return
      }
      stickToEndRef.current = isTabStripScrolledToEnd(el)
      updateTabStripOverflowState()
      recordScrollAnchor()
      // Why: this scroll happens outside a commit, so the commit-end notify can't see it.
      notifyTabStripListeners(stripResizeListenersRef)
    }
    el.addEventListener('pointerleave', onPointerLeave)
    return () => el.removeEventListener('pointerleave', onPointerLeave)
  }, [recordScrollAnchor, updateTabStripOverflowState])

  // Why a ref set first: the growth effect below must see this commit's active tab without re-running on every tab switch.
  useLayoutEffect(() => {
    activeTabIdRef.current = activeVisibleTabId
  }, [activeVisibleTabId])
  useLayoutEffect(() => {
    slotIdsRef.current = slotIds
  }, [slotIds])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      prevStripRef.current = null
      return
    }
    const prev = prevStripRef.current
    // Why logical ids: scrolling a windowed strip mounts and unmounts slots without opening or closing tabs.
    const tabIds: ReadonlySet<string> = new Set(slotIdsRef.current)
    prevStripRef.current = { worktreeId, tabIds }
    if (!prev || prev.worktreeId !== worktreeId) {
      hoverDeferredRevealIdsRef.current = new Set()
      updateTabStripOverflowState()
      return
    }
    const pointerGestureActive = isTabStripPointerGestureActive()
    // Why identities, not a count: a tab that replaces another opens without the strip growing.
    const tabOpened = [...tabIds].some((id) => !prev.tabIds.has(id))
    tabClosedThisCommitRef.current = !tabOpened && [...prev.tabIds].some((id) => !tabIds.has(id))
    if (tabClosedThisCommitRef.current) {
      tabCloseGenerationRef.current += 1
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
        // Preserve the viewed tab’s x through insertion; reveal only offscreen destinations while the active tab docks.
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
          } else {
            const opened = [...tabIds].filter((id) => !prev.tabIds.has(id))
            revealFirstUnmountedTabStripSlot(strip, slotIdsRef.current, opened)
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
  }, [layoutKey, recordScrollAnchor, updateTabStripOverflowState, worktreeId])

  useRevealFocusedTabStripSlot({
    activeDockSlotId,
    activeVisibleTabId,
    isFocused,
    tabStripRef,
    tabClosedThisCommitRef,
    tabCloseGenerationRef,
    stickToEndRef,
    recordScrollAnchor,
    updateTabStripOverflowState
  })

  // Dock ownership and drag transitions change sticky layout without scrolling or resizing.
  useLayoutEffect(() => {
    updateTabStripOverflowState()
  }, [activeDockSlotId, isTabDragActive, updateTabStripOverflowState])

  // Why every render: the close flag belongs to the commit that set it, not a later tab switch.
  useLayoutEffect(() => {
    tabClosedThisCommitRef.current = false
  })
  // Why last: it must follow every effect above that scrolls the strip.
  useNotifyTabStripScrollAfterCommit(tabStripRef, stripResizeListenersRef, commitStartScrollRef)

  return {
    tabStripRef,
    tabStripOverflowState,
    activeTabDockSide,
    scrollTabStrip,
    subscribeToStripResize
  }
}
