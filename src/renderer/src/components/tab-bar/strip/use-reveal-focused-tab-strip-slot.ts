import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import {
  isTabStripPointerGestureActive,
  isTabStripPointerGestureRevealOnRelease,
  onTabStripPointerGestureRelease
} from './tab-strip-pointer-gesture'
import { findTabStripSlot, revealTabStripSlot } from './tab-strip-slot-geometry'
import { isTabStripScrolledToEnd } from './tab-strip-scroll-controls'

export function useRevealFocusedTabStripSlot({
  activeDockSlotId,
  activeVisibleTabId,
  isFocused,
  tabStripRef,
  tabClosedThisCommitRef,
  tabCloseGenerationRef,
  stickToEndRef,
  recordScrollAnchor,
  updateTabStripOverflowState
}: {
  activeDockSlotId: string | null
  activeVisibleTabId: string | null
  isFocused: boolean | undefined
  tabStripRef: RefObject<HTMLDivElement | null>
  tabClosedThisCommitRef: MutableRefObject<boolean>
  tabCloseGenerationRef: MutableRefObject<number>
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
      return undefined
    }
    const focusChanged = previousFocusRef.current !== isFocused
    previousFocusRef.current = isFocused
    if (focusChanged && !isFocused) {
      recordScrollAnchor()
      return undefined
    }
    if (isTabStripPointerGestureActive()) {
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      if (!isTabStripPointerGestureRevealOnRelease()) {
        return undefined
      }
      if (tabClosedThisCommitRef.current) {
        return undefined
      }
      let removeReleaseListener = (): void => {}
      const closeGeneration = tabCloseGenerationRef.current
      removeReleaseListener = onTabStripPointerGestureRelease(() => {
        removeReleaseListener()
        requestAnimationFrame(() => {
          if (isFocusedRef.current && closeGeneration === tabCloseGenerationRef.current) {
            revealFocusedSlot()
          }
        })
      })
      return removeReleaseListener
    }
    if (tabClosedThisCommitRef.current) {
      requestAnimationFrame(updateTabStripOverflowState)
      recordScrollAnchor()
      return undefined
    }
    revealFocusedSlot()
    return undefined
  }, [
    activeDockSlotId,
    activeVisibleTabId,
    isFocused,
    recordScrollAnchor,
    revealFocusedSlot,
    tabClosedThisCommitRef,
    tabCloseGenerationRef,
    tabStripRef,
    updateTabStripOverflowState
  ])
}
