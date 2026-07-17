import React, { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isRightSidebarEdgePeekEnabled } from './right-sidebar-edge-peek-preference'

// Arc-style edge peek: hovering the window's right edge while the sidebar is
// closed reveals it as a floating overlay instead of reflowing the editor.
// The enter delay keeps edge scrollbar grabs from flashing the sidebar open.
export const PEEK_OPEN_DELAY_MS = 250
export const PEEK_CLOSE_DELAY_MS = 300
// Why: mousedown alone is not enough — users hover the edge to aim at a
// scrollbar, then press. Without a post-gesture cool-down the 250ms dwell
// re-arms the moment they release (or after a short hover before the press).
export const PEEK_GESTURE_SUPPRESS_MS = 600
// The rightmost band that arms the peek, and the top zone it excludes.
const PEEK_EDGE_TRIGGER_PX = 6
const PEEK_TITLEBAR_ZONE_PX = 36
// Native + common custom scrollbar hit targets near a scrollport's right edge.
const PEEK_SCROLLBAR_HIT_PX = 16
const PEEK_CUSTOM_SCROLLBAR_SELECTOR = [
  '.monaco-scrollable-element > .scrollbar',
  '.monaco-scrollable-element .slider',
  '.xterm-viewport',
  '[data-slot="scroll-area-scrollbar"]',
  '[data-slot="scroll-area-thumb"]',
  '[data-radix-scroll-area-scrollbar]',
  '[data-radix-scroll-area-thumb]'
].join(',')
const PEEK_INTERACTIVE_PORTAL_SELECTOR = [
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="hover-card-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]'
].join(',')

/**
 * True when the pointer is on (or in the gutter of) a vertical scrollbar of a
 * scrollable ancestor. Only cheap geometry walks when already inside the edge
 * band — callers must gate that first.
 */
export function isPointerOverVerticalScrollbar(event: MouseEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) {
    return false
  }
  if (target.closest(PEEK_CUSTOM_SCROLLBAR_SELECTOR)) {
    return true
  }
  let node: Element | null = target
  // Cap the walk: deep trees (Monaco/xterm) still resolve within a few levels.
  for (let depth = 0; depth < 16 && node && node !== document.documentElement; depth++) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node)
      const overflowY = style.overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        const rect = node.getBoundingClientRect()
        // Why: clientWidth excludes classic scrollbars; overlay scrollbars still
        // live against the box's right edge. Either way the interactive gutter
        // is the last ~16px of the scrollport.
        if (
          event.clientX >= rect.right - PEEK_SCROLLBAR_HIT_PX &&
          event.clientX <= rect.right + 2
        ) {
          return true
        }
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * Arms the edge peek while the sidebar is fully hidden. Detection is
 * geometry-based (a window mousemove comparing clientX against the right edge)
 * rather than an invisible DOM strip: a strip would swallow every mousedown in
 * the rightmost pixels, blocking scrollbar drags and clicks flush against the
 * window edge. Renders nothing.
 */
export function RightSidebarEdgePeekZone(): React.JSX.Element | null {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarPeek = useAppStore((s) => s.rightSidebarPeek)
  const setRightSidebarPeek = useAppStore((s) => s.setRightSidebarPeek)
  const edgePeekEnabled = useAppStore((s) => isRightSidebarEdgePeekEnabled(s.settings))

  useEffect(() => {
    // Why: the zone unmounts when the active view loses sidebar controls; a
    // peek flag surviving that would render a ghost peek (no hover behind it)
    // when the user returns to a sidebar-capable view.
    return () => setRightSidebarPeek(false)
  }, [setRightSidebarPeek])

  useEffect(() => {
    // Why: an active peek must collapse immediately when the user turns the
    // setting off mid-gesture so the overlay doesn't stick without a dismiss
    // path that matches their preference.
    if (!edgePeekEnabled && rightSidebarPeek) {
      setRightSidebarPeek(false)
    }
  }, [edgePeekEnabled, rightSidebarPeek, setRightSidebarPeek])

  useEffect(() => {
    // The revealed overlay covers the edge, so arming is only needed while the
    // sidebar is fully hidden. Skipping the listener here also guarantees an
    // armed timer can't fire after the sidebar opens (the cleanup clears it).
    if (!edgePeekEnabled || rightSidebarOpen || rightSidebarPeek) {
      return
    }
    let openTimer: number | null = null
    // Why: wall-clock suppress window for button/scroll gestures so a timer
    // armed on pure hover cannot fire after (or during) scrollbar use.
    let suppressUntilMs = 0
    const clearOpenTimer = (): void => {
      if (openTimer !== null) {
        window.clearTimeout(openTimer)
        openTimer = null
      }
    }
    const suppressArming = (): void => {
      clearOpenTimer()
      suppressUntilMs = performance.now() + PEEK_GESTURE_SUPPRESS_MS
    }
    const onMouseMove = (event: MouseEvent): void => {
      // Why: scrollbar and resize drags can remain in the edge band longer
      // than the hover delay; pressed buttons must never arm an overlay.
      if (event.buttons !== 0) {
        suppressArming()
        return
      }
      if (performance.now() < suppressUntilMs) {
        clearOpenTimer()
        return
      }
      // Why: exclude the top 36px titlebar row so the peek never arms over
      // window controls (Windows/Linux custom chrome).
      const inEdgeBand =
        event.clientY >= PEEK_TITLEBAR_ZONE_PX &&
        event.clientX >= window.innerWidth - PEEK_EDGE_TRIGGER_PX
      if (!inEdgeBand) {
        clearOpenTimer()
        return
      }
      // Why: the right edge is exactly where vertical scrollbars live. Pure
      // hover over a scrollbar (before mousedown) used to open the peek and
      // cover the thumb mid-drag aim.
      if (isPointerOverVerticalScrollbar(event)) {
        suppressArming()
        return
      }
      if (openTimer === null) {
        openTimer = window.setTimeout(() => {
          openTimer = null
          // Why: re-check suppress at fire time — a mousedown/scroll during the
          // dwell window must still win even if mousemove stopped.
          if (performance.now() < suppressUntilMs) {
            return
          }
          setRightSidebarPeek(true)
        }, PEEK_OPEN_DELAY_MS)
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    // Why: mousedown clears an armed dwell; mouseup starts the cool-down so
    // release-after-scrollbar-drag cannot immediately re-arm.
    window.addEventListener('mousedown', suppressArming)
    window.addEventListener('mouseup', suppressArming)
    window.addEventListener('wheel', suppressArming, { passive: true })
    // Capture: scroll can fire on nested containers, not the window.
    window.addEventListener('scroll', suppressArming, { capture: true, passive: true })
    window.addEventListener('blur', clearOpenTimer)
    document.documentElement.addEventListener('mouseleave', clearOpenTimer)
    return () => {
      clearOpenTimer()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mousedown', suppressArming)
      window.removeEventListener('mouseup', suppressArming)
      window.removeEventListener('wheel', suppressArming)
      window.removeEventListener('scroll', suppressArming, true)
      window.removeEventListener('blur', clearOpenTimer)
      document.documentElement.removeEventListener('mouseleave', clearOpenTimer)
    }
  }, [edgePeekEnabled, rightSidebarOpen, rightSidebarPeek, setRightSidebarPeek])

  return null
}

/**
 * Dismisses an active peek once the pointer moves left of the revealed
 * overlay. Dismissal is geometry-based (window mousemove) rather than
 * mouseleave-based: tooltips and menus portal outside the overlay element,
 * and a mouseleave dismiss would close the peek under an open popover.
 */
export function useRightSidebarEdgePeekDismiss(args: {
  isPeeking: boolean
  isResizing: boolean
  setPeek: (peek: boolean) => void
  overlayRef: React.RefObject<HTMLElement | null>
}): void {
  const { isPeeking, isResizing, setPeek, overlayRef } = args
  // Why: the dismiss watcher reads resize state inside window listeners; a ref
  // avoids re-subscribing them on every drag frame.
  const isResizingRef = useRef(isResizing)
  isResizingRef.current = isResizing

  useEffect(() => {
    if (!isPeeking) {
      return
    }
    let closeTimer: number | null = null
    let lastClientX: number | null = null
    // Why: measuring the overlay on every mousemove forces layout. Cache its
    // left edge and invalidate only when it can move (a resize drag or a window
    // resize), so the common per-frame move reads no geometry.
    let cachedOverlayLeft: number | null = null
    const invalidateOverlayLeft = (): void => {
      cachedOverlayLeft = null
    }
    const cancelClose = (): void => {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer)
        closeTimer = null
      }
    }
    const scheduleClose = (): void => {
      if (closeTimer === null) {
        closeTimer = window.setTimeout(() => {
          closeTimer = null
          // Why: the cached boundary may have been measured mid slide-in (the
          // entrance transform puts the rect near the window edge). Re-measure
          // and re-check here so a stale cache self-heals instead of
          // dismissing the peek under the cursor.
          const overlayLeft = overlayRef.current?.getBoundingClientRect().left ?? null
          cachedOverlayLeft = overlayLeft
          if (overlayLeft !== null && lastClientX !== null && lastClientX >= overlayLeft) {
            return
          }
          setPeek(false)
        }, PEEK_CLOSE_DELAY_MS)
      }
    }
    const onMouseMove = (event: MouseEvent): void => {
      lastClientX = event.clientX
      // A resize drag legitimately travels left of the overlay edge.
      if (isResizingRef.current) {
        invalidateOverlayLeft()
        cancelClose()
        return
      }
      if (cachedOverlayLeft === null) {
        cachedOverlayLeft = overlayRef.current?.getBoundingClientRect().left ?? null
      }
      if (cachedOverlayLeft === null || event.clientX >= cachedOverlayLeft) {
        cancelClose()
      } else if (
        // Why: only inspect the DOM after the cheap geometry check; Radix
        // portals can extend left but ordinary in-panel moves stay O(1).
        event.target instanceof Element &&
        event.target.closest(PEEK_INTERACTIVE_PORTAL_SELECTOR)
      ) {
        cancelClose()
      } else {
        scheduleClose()
      }
    }
    const dismissPeek = (): void => {
      cancelClose()
      setPeek(false)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('blur', dismissPeek)
    window.addEventListener('resize', invalidateOverlayLeft)
    document.documentElement.addEventListener('mouseleave', dismissPeek)
    return () => {
      cancelClose()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('blur', dismissPeek)
      window.removeEventListener('resize', invalidateOverlayLeft)
      document.documentElement.removeEventListener('mouseleave', dismissPeek)
    }
  }, [isPeeking, overlayRef, setPeek])
}
