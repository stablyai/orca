import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { inRowCardGraceArea, type Point } from './bot-row-card-grace'

/** The right sidebar's panel; a row's card opens outside its left edge. */
const SIDE_PANEL = '[data-right-sidebar-panel]'
/** Between the card's right edge and the panel's left edge. */
const PANEL_GAP = 8

function overAnotherTrigger(target: EventTarget | null, row: HTMLElement): boolean {
  const trigger = target instanceof Element && target.closest('[data-slot=hover-card-trigger]')
  return Boolean(trigger && trigger !== row)
}

function trackPointerInGap(
  onMove: (event: PointerEvent) => void,
  onWindowExit: () => void
): () => void {
  document.addEventListener('pointermove', onMove, { capture: true, passive: true })
  const root = document.documentElement
  root.addEventListener('pointerleave', onWindowExit)
  return () => {
    root.removeEventListener('pointerleave', onWindowExit)
    document.removeEventListener('pointermove', onMove, true)
  }
}

export function useBotRowCardPlacement() {
  const triggerNode = useRef<HTMLElement | null>(null)
  const cardNode = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [sideOffset, setSideOffset] = useState(PANEL_GAP)
  const [maxWidth, setMaxWidth] = useState<number>()
  useLayoutEffect(() => {
    const row = triggerNode.current
    const panel = row?.closest(SIDE_PANEL)
    if (!open || !row) {
      return
    }
    if (!panel) {
      setSideOffset(PANEL_GAP)
      setMaxWidth(undefined)
      return
    }
    const measure = (): void => {
      const left = panel.getBoundingClientRect().left
      setSideOffset(Math.max(0, row.getBoundingClientRect().left - left) + PANEL_GAP)
      setMaxWidth(Math.max(0, left - 2 * PANEL_GAP))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(panel)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  const crossing = useRef<{ hold: () => boolean; stop: () => void } | null>(null)
  const settle = useCallback(() => {
    crossing.current?.stop()
    crossing.current = null
  }, [])
  const close = useCallback(() => {
    settle()
    setOpen(false)
  }, [settle])
  useEffect(() => settle, [settle])

  const onPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!open || event.pointerType === 'touch') {
        return
      }
      const row = event.currentTarget
      settle()
      if (overAnotherTrigger(event.relatedTarget, row)) {
        return
      }
      // A fast move can report its destination as the leave coordinate.
      const box = row.getBoundingClientRect()
      const exit = { x: box.left, y: Math.max(box.top, Math.min(box.bottom, event.clientY)) }
      let pointer: Point | null = { x: event.clientX, y: event.clientY }
      let held = false
      const hold = (): boolean => {
        const card = cardNode.current?.getBoundingClientRect()
        held = Boolean(pointer && card && inRowCardGraceArea(pointer, exit, card))
        return held
      }
      const onMove = (move: PointerEvent): void => {
        pointer = overAnotherTrigger(move.target, row) ? null : { x: move.clientX, y: move.clientY }
        if (held && !hold()) {
          close()
        }
      }
      crossing.current = { hold, stop: trackPointerInGap(onMove, close) }
    },
    [open, close, settle]
  )

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setOpen(true)
      } else if (!crossing.current?.hold()) {
        close()
      }
    },
    [close]
  )

  return {
    root: { open, onOpenChange },
    trigger: {
      ref: useCallback((node: HTMLElement | null) => {
        triggerNode.current = node
      }, []),
      // Back on the row or on the card: the HoverCard's own hover handling takes over again.
      onPointerEnter: settle,
      onPointerLeave
    },
    content: {
      ref: useCallback((node: HTMLElement | null) => {
        cardNode.current = node
      }, []),
      onPointerEnter: settle,
      onPointerDownOutside: settle,
      onEscapeKeyDown: settle,
      style: { maxWidth },
      side: 'left' as const,
      align: 'start' as const,
      sideOffset,
      collisionPadding: PANEL_GAP
    }
  }
}
