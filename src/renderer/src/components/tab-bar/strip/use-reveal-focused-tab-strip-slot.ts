import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { isTabStripPointerGestureActive, onTabStripPointerGestureRelease } from './tab-strip-pointer-gesture'
import { findTabStripSlot, revealTabStripSlot } from './tab-strip-slot-geometry'
import { isTabStripScrolledToEnd } from './tab-strip-scroll-controls'

export function useRevealFocusedTabStripSlot({
  activeDockSlotId,
  activeVisibleTabId,
  isFocused,
  tabStripRef,
  tabClosedThisCommitRef,
  stickToEndRef,
  recordScrollAnchor,
  updateTabStripOverflowState
}: {
  activeDockSlotId: string | null
  activeVisibleTabId: string | null
  isFocused: boolean | undefined
  tabStripRef: RefObject<HTMLDivElement | null>
  tabClosedThisCommitRef: MutableRefObject<boolean>
  stickToEndRef: MutableRefObject<boolean>
  recordScrollAnchor: () => void
  updateTabStripOverflowState: () => void
}): void {
  const activeDockSlotIdRef = useRef(activeDockSlotId)
  const activeVisibleTabIdRef = useRef(activeVisibleTabId)
  const isFocusedRef = useRef(isFocused)
  const previousFocusRef = useRef(isFocused)

  useLayoutEffect(() => {
    activeDockSlotIdRef.current = activeDockSlotId
    activeVisibleTabIdRef.current = activeVisibleTabId
    isFocusedRef.current = isFocused
  }, [activeDockSlotId, activeVisibleTabId, isFocused])

  const revealFocusedSlot = useCallback((): void => {
    const strip = tabStripRef.current
    const activeSlotId = activeDockSlotIdRef.current ?? activeVisibleTabIdRef.current
    if (!strip || !activeSlotId) {
      recordScrollAnchor()
      return
    }
    const activeSlot = findTabStripSlot(strip, activeSlotId)
    if (!activeSlot) {
      recordScrollAnchor()
      return
    }
    revealTabStripSlot(strip, activeSlot)
    stickToEndRef.current = isTabStripScrolledToEnd(strip)
    requestAnimationFrame(updateTabStripOverflowState)
    recordScrollAnchor()
  }, [recordScrollAnchor, stickToEndRef, tabStripRef, updateTabStripOverflowState])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      return
    }
    const focusChanged = previousFocusRef.current !== isFocused
    previousFocusRef.current = isFocused
    if (focusChanged && !isFocused) {
      recordScrollAnchor()
      return
    }
    if (isTabStripPointerGestureActive()) {
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      let removeReleaseListener = (): void => {}
      removeReleaseListener = onTabStripPointerGestureRelease(() => {
        removeReleaseListener()
        if (isFocusedRef.current) {
          revealFocusedSlot()
        }
      })
      return removeReleaseListener
    }
    if (tabClosedThisCommitRef.current) {
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      return
    }
    revealFocusedSlot()
  }, [
    activeDockSlotId,
    activeVisibleTabId,
    isFocused,
    recordScrollAnchor,
    revealFocusedSlot,
    tabClosedThisCommitRef,
    tabStripRef,
    updateTabStripOverflowState
  ])
}
