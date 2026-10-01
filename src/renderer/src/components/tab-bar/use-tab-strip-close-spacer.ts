import { useCallback, useEffect, useRef, type RefObject } from 'react'

const SLOT_SELECTOR = ':scope > [data-tab-strip-slot]'
const CLOSE_BUTTON_SELECTOR = '[data-tab-close-button]'
// Why a window: a close can commit a tick after its click (store actions, confirm-free async paths).
const MOUSE_CLOSE_WINDOW_MS = 1000

type StripExtent = {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  slotWidths: ReadonlyMap<string, number>
}

function readSlotWidths(strip: HTMLElement): Map<string, number> {
  const widths = new Map<string, number>()
  for (const slot of strip.querySelectorAll<HTMLElement>(SLOT_SELECTOR)) {
    widths.set(slot.dataset.tabStripSlot ?? '', slot.getBoundingClientRect().width)
  }
  return widths
}

/**
 * Chrome-style close. Closing a tab in an overflowing strip shortens it: at the scrolled end the
 * browser clamps scrollLeft and every tab left of the closed one slides under the cursor, and near
 * the overflow threshold every tab widens. After a single close made with the mouse, a trailing
 * spacer stands in for the closed tab, so tabs hold still and the next one slides in under the
 * cursor. The strip settles once the pointer leaves or the user does anything else.
 */
export function useTabStripCloseSpacer(
  tabStripRef: RefObject<HTMLDivElement | null>,
  onRelease: () => void
): {
  closeSpacerRef: RefObject<HTMLDivElement | null>
  /** Call after every layout change, so a close is measured against the strip it removed from. */
  recordStripExtent: (strip: HTMLElement) => void
  holdStripAfterClose: (strip: HTMLElement, closedIds: readonly string[]) => void
  /** New tabs take the held space instead, so the strip keeps its width and scroll. */
  shrinkCloseSpacer: (strip: HTMLElement, openedIds: ReadonlySet<string>) => void
  releaseCloseSpacer: () => boolean
} {
  const closeSpacerRef = useRef<HTMLDivElement>(null)
  const spacerWidthRef = useRef(0)
  const mouseCloseAtRef = useRef(Number.NEGATIVE_INFINITY)
  const extentRef = useRef<StripExtent>({
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    slotWidths: new Map()
  })

  const setSpacerWidth = useCallback((width: number): void => {
    spacerWidthRef.current = width
    const spacer = closeSpacerRef.current
    if (spacer) {
      spacer.style.width = width > 0 ? `${width}px` : ''
    }
  }, [])

  const recordStripExtent = useCallback((strip: HTMLElement): void => {
    extentRef.current = {
      scrollLeft: strip.scrollLeft,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      slotWidths: readSlotWidths(strip)
    }
  }, [])

  const holdStripAfterClose = useCallback(
    (strip: HTMLElement, closedIds: readonly string[]): void => {
      const madeWithMouse = performance.now() - mouseCloseAtRef.current < MOUSE_CLOSE_WINDOW_MS
      mouseCloseAtRef.current = Number.NEGATIVE_INFINITY
      const { scrollLeft, scrollWidth, clientWidth, slotWidths } = extentRef.current
      const hoverTarget = strip.parentElement ?? strip
      // Why one tab: a bulk close is not a click-by-click sweep, and would leave a wide blank.
      if (
        !madeWithMouse ||
        closedIds.length !== 1 ||
        scrollWidth <= clientWidth + 0.5 ||
        !closeSpacerRef.current ||
        !hoverTarget.matches(':hover')
      ) {
        return
      }
      setSpacerWidth(spacerWidthRef.current + (slotWidths.get(closedIds[0]) ?? 0))
      // Why a second pass: sub-pixel tab widths can leave the strip a fraction short.
      const missing = scrollWidth - strip.scrollWidth
      if (missing > 0.5) {
        setSpacerWidth(spacerWidthRef.current + missing)
      }
      strip.scrollLeft = scrollLeft
    },
    [setSpacerWidth]
  )

  const shrinkCloseSpacer = useCallback(
    (strip: HTMLElement, openedIds: ReadonlySet<string>): void => {
      if (spacerWidthRef.current === 0) {
        return
      }
      let openedWidth = 0
      for (const slot of strip.querySelectorAll<HTMLElement>(SLOT_SELECTOR)) {
        if (openedIds.has(slot.dataset.tabStripSlot ?? '')) {
          openedWidth += slot.getBoundingClientRect().width
        }
      }
      setSpacerWidth(Math.max(0, spacerWidthRef.current - openedWidth))
    },
    [setSpacerWidth]
  )

  const releaseCloseSpacer = useCallback((): boolean => {
    if (spacerWidthRef.current === 0) {
      return false
    }
    setSpacerWidth(0)
    return true
  }, [setSpacerWidth])

  useEffect(() => {
    const strip = tabStripRef.current
    // Why the wrapper: the scroll thumb overlays the strip's bottom edge but sits beside it.
    const wrapper = strip?.parentElement
    if (!strip || !wrapper) {
      return
    }
    const markMouseClose = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const isCloseClick = event.type === 'click' && target?.closest(CLOSE_BUTTON_SELECTOR)
      const isMiddleClick = event.type === 'auxclick' && event.button === 1
      if (isCloseClick || isMiddleClick) {
        mouseCloseAtRef.current = performance.now()
      }
    }
    const onScroll = (): void => {
      extentRef.current = { ...extentRef.current, scrollLeft: strip.scrollLeft }
    }
    const settle = (): void => {
      if (releaseCloseSpacer()) {
        onRelease()
        recordStripExtent(strip)
      }
    }
    // Why more than pointerleave: drag regions, hidden worktrees and app switches can swallow it.
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && wrapper.contains(event.target))) {
        settle()
      }
    }
    strip.addEventListener('click', markMouseClose, true)
    strip.addEventListener('auxclick', markMouseClose, true)
    strip.addEventListener('scroll', onScroll, { passive: true })
    wrapper.addEventListener('pointerleave', settle)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', settle, true)
    window.addEventListener('blur', settle)
    return () => {
      strip.removeEventListener('click', markMouseClose, true)
      strip.removeEventListener('auxclick', markMouseClose, true)
      strip.removeEventListener('scroll', onScroll)
      wrapper.removeEventListener('pointerleave', settle)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', settle, true)
      window.removeEventListener('blur', settle)
    }
  }, [onRelease, recordStripExtent, releaseCloseSpacer, tabStripRef])

  return {
    closeSpacerRef,
    recordStripExtent,
    holdStripAfterClose,
    shrinkCloseSpacer,
    releaseCloseSpacer
  }
}
