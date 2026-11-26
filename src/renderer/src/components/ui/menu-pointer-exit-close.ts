import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { overlayFocusContains } from '@/lib/overlay-interaction/overlay-focus-ownership'

type Box = { left: number; top: number; right: number; bottom: number }

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

function span(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom)
  }
}

/**
 * A hover-revealed row menu that a pointer opened closes once the pointer leaves the row and the
 * menu (its portaled submenus included) or leaves the window. The box spanning trigger and menu
 * bridges the gap between them, so no grace timer is needed. Keyboard-opened (or keyboard-used)
 * menus stay open until dismissed as usual. Expects a Radix trigger, whose aria-controls names the menu.
 */
export function useMenuPointerExitClose<Row extends HTMLElement, Trigger extends HTMLElement>() {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<Row>(null)
  const triggerRef = useRef<Trigger>(null)
  const pointerOwned = useRef(false)
  const closedByExit = useRef(false)

  useEffect(() => {
    if (!open) {
      return
    }
    const close = (): void => {
      if (pointerOwned.current) {
        closedByExit.current = true
        setOpen(false)
      }
    }
    const onMove = (event: globalThis.PointerEvent): void => {
      const row = rowRef.current
      const trigger = triggerRef.current
      const menuId = trigger?.getAttribute('aria-controls')
      const menu = menuId ? document.getElementById(menuId) : null
      if (!row || !trigger || !menu) {
        return
      }
      if (event.target instanceof Element && overlayFocusContains(menu, event.target)) {
        return
      }
      const { clientX: x, clientY: y } = event
      const bridge = span(trigger.getBoundingClientRect(), menu.getBoundingClientRect())
      if (!contains(row.getBoundingClientRect(), x, y) && !contains(bridge, x, y)) {
        close()
      }
    }
    // Leaving the window sends no out-of-bounds pointermove, only a pointerout to nowhere.
    const onOut = (event: globalThis.PointerEvent): void => {
      if (event.relatedTarget === null) {
        close()
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerout', onOut)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerout', onOut)
    }
  }, [open])

  const releasePointer = (): void => {
    pointerOwned.current = false
  }
  return {
    rowRef,
    triggerRef,
    open,
    onOpenChange: setOpen,
    triggerProps: {
      onPointerDown: (event: PointerEvent) => {
        pointerOwned.current = event.pointerType !== 'touch'
      },
      onKeyDown: (_event: KeyboardEvent) => releasePointer()
    },
    contentProps: {
      onKeyDown: (_event: KeyboardEvent) => releasePointer(),
      // Returning focus to the trigger would keep the row's focus-revealed actions showing.
      onCloseAutoFocus: (event: Event) => {
        if (closedByExit.current) {
          event.preventDefault()
          closedByExit.current = false
        }
      }
    }
  }
}
