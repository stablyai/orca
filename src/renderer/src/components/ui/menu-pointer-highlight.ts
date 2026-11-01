import * as React from 'react'
import { useComposedRefs } from 'radix-ui/internal'

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const OPEN_POPOVER_TRIGGER_SELECTOR = '[data-slot="popover-trigger"][aria-expanded="true"]'

type Point = { x: number; y: number }

type MenuPointerHighlightState = {
  /** Set by wheel, cleared by keydown so keyboard-driven scrolling keeps its own highlight. */
  wheelArmed: boolean
  pointer: Point | null
  frame: number
}

// Setup inputs can be portaled outside the menu content.
function isEditableFocused(): boolean {
  const active = document.activeElement
  return active instanceof Element && active.matches(EDITABLE_SELECTOR)
}

/**
 * Move the menu highlight to the row under a resting cursor while the menu wheel-scrolls.
 * Radix highlights only on pointermove, and Chromium defers the hover boundary events a scroll
 * causes until the scroll settles, so without this the highlight trails the scroll.
 */
function syncMenuHighlightAtPoint(content: HTMLElement, x: number, y: number): void {
  if (
    content.getAttribute('data-state') === 'closed' ||
    isEditableFocused() ||
    content.querySelector(OPEN_POPOVER_TRIGGER_SELECTOR)
  ) {
    return
  }
  const hit = document.elementFromPoint(x, y)
  // Why: React bubbles wheel/scroll from portaled children (e.g. a row's setup popover); a cursor
  // that is not over this menu says nothing about which of its rows should be highlighted.
  if (!hit || !content.contains(hit)) {
    return
  }
  const active = document.activeElement
  const item = hit.closest(ITEM_SELECTOR)
  if (
    item instanceof HTMLElement &&
    content.contains(item) &&
    !item.hasAttribute('data-disabled')
  ) {
    if (!item.contains(active)) {
      item.focus({ preventScroll: true })
    }
    return
  }
  // Mirror Radix's pointerleave: nothing highlightable under the cursor clears the highlight.
  if (
    active instanceof Element &&
    active !== content &&
    content.contains(active) &&
    active.matches(ITEM_SELECTOR)
  ) {
    content.focus({ preventScroll: true })
  }
}

type Handlers = {
  onWheel?: React.WheelEventHandler<HTMLDivElement>
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>
  onPointerOver?: React.PointerEventHandler<HTMLDivElement>
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>
  onScrollCapture?: React.UIEventHandler<HTMLDivElement>
}

function resetPointerTracking(state: MenuPointerHighlightState): void {
  cancelAnimationFrame(state.frame)
  state.wheelArmed = false
  state.pointer = null
  state.frame = 0
}

/** Content-level handlers that keep the menu highlight on the row under the cursor. */
export function useMenuPointerHighlight(
  props: Handlers & { ref?: React.Ref<HTMLDivElement> }
): Required<Handlers> & { ref: React.RefCallback<HTMLDivElement> } {
  const stateRef = React.useRef<MenuPointerHighlightState>({
    wheelArmed: false,
    pointer: null,
    frame: 0
  })
  const trackContent = React.useCallback((content: HTMLDivElement | null) => {
    const state = stateRef.current
    resetPointerTracking(state)
    if (!content) {
      return
    }
    // A retained content node can reopen before its closing animation unmounts it.
    const observer = new MutationObserver(() => resetPointerTracking(state))
    observer.observe(content, { attributes: true, attributeFilter: ['data-state'] })
    return () => {
      observer.disconnect()
      resetPointerTracking(state)
    }
  }, [])
  const ref = useComposedRefs(props.ref, trackContent)

  return {
    ref,
    onWheel: (event) => {
      props.onWheel?.(event)
      stateRef.current.wheelArmed = true
      stateRef.current.pointer = { x: event.clientX, y: event.clientY }
    },
    onPointerMove: (event) => {
      props.onPointerMove?.(event)
      const state = stateRef.current
      if (event.pointerType !== 'mouse') {
        return
      }
      state.pointer = { x: event.clientX, y: event.clientY }
    },
    // Why: the deferred boundary events after a scroll fire Radix's pointerleave on the row that
    // used to be under the cursor, which clears the highlight; re-sync once they land.
    onPointerOver: (event) => {
      props.onPointerOver?.(event)
      if (stateRef.current.wheelArmed && event.pointerType === 'mouse') {
        syncMenuHighlightAtPoint(event.currentTarget, event.clientX, event.clientY)
      }
    },
    onPointerLeave: (event) => {
      props.onPointerLeave?.(event)
      stateRef.current.pointer = null
    },
    // Inputs can stop propagation when transferring keyboard focus to a menu item.
    onKeyDownCapture: (event) => {
      stateRef.current.wheelArmed = false
      props.onKeyDownCapture?.(event)
    },
    // Capture so menus that scroll an inner list (not the content itself) are covered too.
    onScrollCapture: (event) => {
      props.onScrollCapture?.(event)
      const state = stateRef.current
      if (!state.wheelArmed || !state.pointer || state.frame) {
        return
      }
      const content = event.currentTarget
      state.frame = requestAnimationFrame(() => {
        state.frame = 0
        if (state.wheelArmed && state.pointer) {
          syncMenuHighlightAtPoint(content, state.pointer.x, state.pointer.y)
        }
      })
    }
  }
}
