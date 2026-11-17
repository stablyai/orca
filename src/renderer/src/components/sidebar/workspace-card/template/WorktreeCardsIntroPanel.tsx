import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePortalContainer } from '@/components/ui/portal-container-context'
import { ContextualTourArrow } from '@/components/contextual-tours/ContextualTourArrow'
import {
  watchContextualTourFloatingPosition,
  type ContextualTourFloatingPosition
} from '@/components/contextual-tours/contextual-tour-floating-position'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'

// Below this much room right of the sidebar the tiles get unreadable, so the note drops under the first row.
const MIN_SIDE_WIDTH = 260
const MAX_WIDTH = 360
// Matches the floating helper's gap and collision padding.
const SIDE_GAP = 12
const VIEWPORT_PADDING = 12

type Layout = { side: 'right' | 'bottom'; width: number }

function measureLayout(anchor: HTMLElement): Layout {
  const room =
    window.innerWidth - anchor.getBoundingClientRect().right - SIDE_GAP - VIEWPORT_PADDING
  return room >= MIN_SIDE_WIDTH
    ? { side: 'right', width: Math.min(MAX_WIDTH, room) }
    : { side: 'bottom', width: Math.min(MAX_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2) }
}

/** Re-measures as the sidebar or window resizes; observers live only while the note is open. */
function useAnchorLayout(anchor: HTMLElement | null): Layout | null {
  const [layout, setLayout] = useState<Layout | null>(null)
  useLayoutEffect(() => {
    if (!anchor) {
      return
    }
    const measure = (): void => {
      const next = measureLayout(anchor)
      setLayout((prev) =>
        prev && prev.side === next.side && prev.width === next.width ? prev : next
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor])
  return layout
}

function isPassiveFocus(element: Element | null): boolean {
  return element === null || element === document.body
}

function canTakeFocus(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !isPassiveFocus(element) &&
    !element.closest('[inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
  )
}

/**
 * Non-modal note beside the sidebar's card list. Page chrome, not an overlay: no Radix layer,
 * so Escape and focus outside it stay with the page, terminal and real menus/dialogs.
 */
export function WorktreeCardsIntroPanel({
  labelledBy,
  onEscape,
  children
}: {
  labelledBy: string
  onEscape: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const portalContainer = usePortalContainer()
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const layout = useAnchorLayout(anchor)
  const panelRef = useRef<HTMLElement | null>(null)
  const arrowRef = useRef<SVGSVGElement | null>(null)
  const [position, setPosition] = useState<ContextualTourFloatingPosition | null>(null)
  const side = layout?.side

  useLayoutEffect(() => {
    const panel = panelRef.current
    const arrow = arrowRef.current
    if (!anchor || !panel || !arrow || !side) {
      return
    }
    // Why no reset to hidden on side changes: hiding the note would blur a focused tile.
    return watchContextualTourFloatingPosition({
      arrowElement: arrow,
      floatingElement: panel,
      panelHost: null,
      preferredPlacement: side,
      alignStart: true,
      targetElement: anchor,
      onPosition: setPosition
    })
  }, [anchor, side])

  const placed = position !== null
  const initialFocusTriedRef = useRef(false)
  useLayoutEffect(() => {
    // Why after placement: a still-hidden note can't take focus.
    if (!placed || initialFocusTriedRef.current) {
      return
    }
    initialFocusTriedRef.current = true
    // Why: it opens at launch; never pull focus out of a terminal or editor someone is typing in.
    if (isPassiveFocus(document.activeElement)) {
      panelRef.current
        ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
        ?.focus({ preventScroll: true })
    }
  }, [placed])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const opener = isPassiveFocus(document.activeElement) ? null : document.activeElement
    return () => {
      // Runs before the nodes are removed: hand focus back only if the note owned it.
      if (!panel?.contains(document.activeElement)) {
        return
      }
      // Why check each try: a disabled or hidden opener can refuse focus; then the list still gets it.
      for (const candidate of [opener, document.querySelector('[data-worktree-sidebar]')]) {
        if (canTakeFocus(candidate)) {
          candidate.focus({ preventScroll: true })
          if (document.activeElement === candidate) {
            return
          }
        }
      }
    }
  }, [])

  const panel = (
    <section
      ref={panelRef}
      role="complementary"
      aria-labelledby={labelledBy}
      data-worktree-cards-intro=""
      // Paint-only: native views (docked DevTools) step aside, without making this an Escape owner.
      data-paints-over-native-views=""
      // Why z-[47]: above floating terminal (45) and its toggle (46), below dialogs/sheets (50) and popovers/menus/tooltips.
      className="fixed z-[47] rounded-xl border border-border bg-popover text-[13px] text-popover-foreground shadow-floating"
      style={{
        ...(position?.panelPosition ?? { left: 0, top: 0, visibility: 'hidden' }),
        width: layout?.width ?? MAX_WIDTH
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event.nativeEvent)) {
          return
        }
        // Why: this press is the note's; page Escape handlers skip defaultPrevented events.
        event.preventDefault()
        event.stopPropagation()
        onEscape()
      }}
    >
      <ContextualTourArrow
        arrowRef={arrowRef}
        placement={position?.panelPlacement ?? side ?? 'right'}
        style={position?.arrowPosition ?? { visibility: 'hidden' }}
        className="fill-popover stroke-border"
      />
      <div className="scrollbar-sleek max-h-[calc(100vh-24px)] overflow-y-auto p-4">{children}</div>
    </section>
  )

  return (
    <>
      {/* Why an overlay anchor: a band over the list's first row, without adding a row to the list. */}
      <div aria-hidden="true" className="relative h-0 shrink-0">
        <div ref={setAnchor} className="pointer-events-none absolute inset-x-0 top-0 h-14" />
      </div>
      {createPortal(panel, portalContainer ?? document.body)}
    </>
  )
}
