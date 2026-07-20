import React, { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'

// Arc-style edge peek: hovering the window's left edge while the sidebar is
// closed reveals it as a floating overlay instead of reflowing the workspace.
// The enter delay keeps accidental edge grazes from flashing the sidebar open.
export const PEEK_OPEN_DELAY_MS = 250
export const PEEK_CLOSE_DELAY_MS = 300
// Floating elevation from docs/STYLEGUIDE.md — reserved for overlays that
// escape the editor surface.
export const LEFT_SIDEBAR_PEEK_OVERLAY_CLASS_NAME =
  'absolute inset-y-0 left-0 z-30 shadow-[0_10px_24px_rgba(0,0,0,0.18)] animate-in slide-in-from-left duration-200 motion-reduce:animate-none'
// Why: when the collapsed titlebar stays floating (so the tab spacer width
// does not jump), the peek panel starts below that 36px chrome so Tasks/nav
// are not covered by traffic lights / sidebar toggle.
export const LEFT_SIDEBAR_PEEK_BELOW_TITLEBAR_CLASS_NAME =
  'absolute bottom-0 left-0 top-[36px] z-30 shadow-[0_10px_24px_rgba(0,0,0,0.18)] animate-in slide-in-from-left duration-200 motion-reduce:animate-none'
// The leftmost band that arms the peek, and the top zone it excludes.
const PEEK_EDGE_TRIGGER_PX = 6
const PEEK_TITLEBAR_ZONE_PX = 36

/**
 * Arms the edge peek while the sidebar is fully hidden. Detection is
 * geometry-based (a window mousemove comparing clientX against the left edge)
 * rather than an invisible DOM strip: a strip would swallow every mousedown in
 * the leftmost pixels, blocking clicks flush against the window edge (and Mac
 * traffic-light hit targets that extend below the titlebar on some builds).
 * Renders nothing.
 */
export function LeftSidebarEdgePeekZone(): React.JSX.Element | null {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarPeek = useAppStore((s) => s.sidebarPeek)
  const setSidebarPeek = useAppStore((s) => s.setSidebarPeek)

  useEffect(() => {
    // Why: the zone unmounts on full-page views that remove the sidebar; a
    // peek flag surviving that would render a ghost peek when returning.
    return () => setSidebarPeek(false)
  }, [setSidebarPeek])

  useEffect(() => {
    // The revealed overlay covers the edge, so arming is only needed while the
    // sidebar is fully hidden. Skipping the listener here also guarantees an
    // armed timer can't fire after the sidebar opens (the cleanup clears it).
    if (sidebarOpen || sidebarPeek) {
      return
    }
    let openTimer: number | null = null
    const clearOpenTimer = (): void => {
      if (openTimer !== null) {
        window.clearTimeout(openTimer)
        openTimer = null
      }
    }
    const onMouseMove = (event: MouseEvent): void => {
      // Why: ignore button-down moves so a drag that starts near the left edge
      // (scrollbar, text selection, pane resize) does not arm the peek.
      if (event.buttons !== 0) {
        clearOpenTimer()
        return
      }
      // Why: exclude the top 36px titlebar row so the peek never arms over
      // window controls (macOS traffic lights / Windows-Linux custom chrome).
      const inEdgeBand =
        event.clientY >= PEEK_TITLEBAR_ZONE_PX && event.clientX <= PEEK_EDGE_TRIGGER_PX
      if (!inEdgeBand) {
        clearOpenTimer()
        return
      }
      if (openTimer === null) {
        openTimer = window.setTimeout(() => {
          openTimer = null
          setSidebarPeek(true)
        }, PEEK_OPEN_DELAY_MS)
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => {
      clearOpenTimer()
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [sidebarOpen, sidebarPeek, setSidebarPeek])

  return null
}

/**
 * Dismisses an active peek once the pointer moves right of the revealed
 * overlay. Dismissal is geometry-based (window mousemove) rather than
 * mouseleave-based: tooltips and menus portal outside the overlay element,
 * and a mouseleave dismiss would close the peek under an open popover.
 */
export function useLeftSidebarEdgePeekDismiss(args: {
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
    // right edge and invalidate only when it can move (a resize drag or a
    // window resize), so the common per-frame move reads no geometry.
    let cachedOverlayRight: number | null = null
    const invalidateOverlayRight = (): void => {
      cachedOverlayRight = null
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
          const overlayRight = overlayRef.current?.getBoundingClientRect().right ?? null
          cachedOverlayRight = overlayRight
          if (overlayRight !== null && lastClientX !== null && lastClientX <= overlayRight) {
            return
          }
          setPeek(false)
        }, PEEK_CLOSE_DELAY_MS)
      }
    }
    const onMouseMove = (event: MouseEvent): void => {
      lastClientX = event.clientX
      // A resize drag legitimately travels right of the overlay edge.
      if (isResizingRef.current) {
        invalidateOverlayRight()
        cancelClose()
        return
      }
      if (cachedOverlayRight === null) {
        cachedOverlayRight = overlayRef.current?.getBoundingClientRect().right ?? null
      }
      if (cachedOverlayRight === null || event.clientX <= cachedOverlayRight) {
        cancelClose()
      } else {
        scheduleClose()
      }
    }
    const onWindowBlur = (): void => setPeek(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('resize', invalidateOverlayRight)
    return () => {
      cancelClose()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('resize', invalidateOverlayRight)
    }
  }, [isPeeking, overlayRef, setPeek])
}
