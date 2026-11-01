import * as React from 'react'
import { useComposedRefs } from 'radix-ui/internal'

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const OPEN_POPOVER_TRIGGER_SELECTOR = '[data-slot="popover-trigger"][aria-expanded="true"]'
const OPEN_SUBMENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"][data-state="open"]'

/** A cursor that stops this long over another row is not travelling into the open submenu. */
export const MENU_POINTER_REST_MS = 120

type Point = { x: number; y: number }

type MenuPointerHighlightState = {
  /** Set by wheel, cleared by keydown so keyboard-driven scrolling keeps its own highlight. */
  wheelArmed: boolean
  pointer: Point | null
  frame: number
  restTimer: number
}

// Setup inputs can be portaled outside the menu content.
function isEditableFocused(): boolean {
  const active = document.activeElement
  return active instanceof Element && active.matches(EDITABLE_SELECTOR)
}

/** The enabled row of this menu (not a portaled submenu) under a viewport point. */
function itemAtPoint(content: HTMLElement, { x, y }: Point): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)
  const item = hit && content.contains(hit) ? hit.closest(ITEM_SELECTOR) : null
  return item instanceof HTMLElement && content.contains(item) ? item : null
}

/**
 * Move the menu highlight to the row under a resting cursor while the menu wheel-scrolls.
 * Radix highlights only on pointermove, and Chromium defers the hover boundary events a scroll
 * causes until the scroll settles, so without this the highlight trails the scroll.
 */
export function syncMenuHighlightAtPoint(content: HTMLElement, x: number, y: number): void {
  if (
    content.getAttribute('data-state') === 'closed' ||
    // Why: an open submenu means Radix's pointer-grace logic owns highlight changes.
    content.querySelector(OPEN_SUBMENU_TRIGGER_SELECTOR) ||
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
  const item = itemAtPoint(content, { x, y })
  if (item && !item.hasAttribute('data-disabled')) {
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

/**
 * Radix's submenu "safe triangle" swallows pointermoves that look headed for the open submenu,
 * and never re-checks once the cursor stops, so a fast flick that drifts toward the submenu
 * leaves the old row highlighted and its submenu open until the mouse moves again. A cursor at
 * rest over a different row has clearly chosen that row: highlight it, which closes the stale
 * submenu through Radix's own focus-outside handling. Activate submenu triggers to complete the
 * handoff without requiring another pointer movement.
 */
export function settleMenuHighlightAfterRest(content: HTMLElement, point: Point): void {
  const openTrigger = content.querySelector(OPEN_SUBMENU_TRIGGER_SELECTOR)
  if (
    !openTrigger ||
    content.getAttribute('data-state') === 'closed' ||
    isEditableFocused() ||
    content.querySelector(OPEN_POPOVER_TRIGGER_SELECTOR)
  ) {
    return
  }
  const item = itemAtPoint(content, point)
  if (!item || item === openTrigger || item.hasAttribute('data-disabled')) {
    return
  }
  item.focus({ preventScroll: true })
  if (item.getAttribute('aria-haspopup') === 'menu') {
    item.click()
  }
}

type Handlers = {
  onWheel?: React.WheelEventHandler<HTMLDivElement>
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>
  onPointerOver?: React.PointerEventHandler<HTMLDivElement>
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>
  onScrollCapture?: React.UIEventHandler<HTMLDivElement>
}

function clearRestTimer(state: MenuPointerHighlightState): void {
  window.clearTimeout(state.restTimer)
  state.restTimer = 0
}

function resetPointerTracking(state: MenuPointerHighlightState): void {
  cancelAnimationFrame(state.frame)
  clearRestTimer(state)
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
    frame: 0,
    restTimer: 0
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
      const previous = state.pointer
      // Why: a pointermove without movement is not the cursor travelling, so it must not restart the rest wait.
      if (previous && previous.x === event.clientX && previous.y === event.clientY) {
        return
      }
      const point = { x: event.clientX, y: event.clientY }
      state.pointer = point
      clearRestTimer(state)
      const content = event.currentTarget
      if (!content.querySelector(OPEN_SUBMENU_TRIGGER_SELECTOR)) {
        return
      }
      state.restTimer = window.setTimeout(() => {
        state.restTimer = 0
        settleMenuHighlightAfterRest(content, point)
      }, MENU_POINTER_REST_MS)
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
      clearRestTimer(stateRef.current)
    },
    onKeyDown: (event) => {
      props.onKeyDown?.(event)
    },
    // Inputs can stop propagation when transferring keyboard focus to a menu item.
    onKeyDownCapture: (event) => {
      stateRef.current.wheelArmed = false
      clearRestTimer(stateRef.current)
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
