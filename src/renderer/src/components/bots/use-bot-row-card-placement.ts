// Where a right side-panel row's hover card opens: beside the panel, over the main view, so it covers
// nothing in the panel (not the row, its status icon or the rows around it).
import { useCallback, useEffect, useRef, useState } from 'react'
import { inRowCardGraceArea, type Point } from './bot-row-card-grace'

/** The right sidebar's panel; a row's card opens outside its left edge. */
const SIDE_PANEL = '[data-right-sidebar-panel]'
/** Between the card's right edge and the panel's left edge. */
const PANEL_GAP = 8

export type BotRowCardPlacement = {
  /** Spread on the HoverCard: the card's open state. */
  root: { open: boolean; onOpenChange: (open: boolean) => void }
  /** Spread on the HoverCardTrigger. */
  trigger: {
    ref: (node: HTMLElement | null) => void
    onPointerEnter: () => void
    onPointerLeave: (event: React.PointerEvent) => void
  }
  /** Spread on the HoverCardContent. */
  content: {
    ref: (node: HTMLElement | null) => void
    onPointerEnter: () => void
    side: 'left'
    align: 'start'
    sideOffset: number
    collisionPadding: number
  }
}

/** Opens the card left of the side panel with its top at the row's, shifted up only to stay in the window.
 *  The gap the pointer crosses from the row to the card keeps it open, and closing still waits the
 *  HoverCard's close delay. Outside a side panel (a fixture, another surface) the card opens beside the row. */
export function useBotRowCardPlacement(): BotRowCardPlacement {
  const triggerNode = useRef<HTMLElement | null>(null)
  const cardNode = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [sideOffset, setSideOffset] = useState(PANEL_GAP)
  // Where the pointer left the row while its card was open, until it reaches the card or the row again.
  const exit = useRef<Point | null>(null)
  const pointer = useRef<Point | null>(null)
  // Set while a close request is held because the pointer is on its way to the card.
  const held = useRef(false)
  const untrack = useRef<(() => void) | null>(null)

  const settle = useCallback(() => {
    untrack.current?.()
    untrack.current = null
    exit.current = null
    held.current = false
  }, [])
  const close = useCallback(() => {
    settle()
    setOpen(false)
  }, [settle])
  useEffect(() => settle, [settle])

  const onPointerLeave = useCallback(
    (event: React.PointerEvent) => {
      if (!open || event.pointerType === 'touch') {
        return
      }
      exit.current = { x: event.clientX, y: event.clientY }
      pointer.current = exit.current
      if (untrack.current) {
        return
      }
      // Listened only between leaving the row and reaching the card, so idle rows cost nothing.
      const onMove = (move: PointerEvent): void => {
        pointer.current = { x: move.clientX, y: move.clientY }
        if (!held.current || !exit.current) {
          return
        }
        const card = cardNode.current?.getBoundingClientRect()
        if (!card || !inRowCardGraceArea(pointer.current, exit.current, card)) {
          close()
        }
      }
      // A click or Escape while crossing the gap closes the card as it would anywhere else.
      const onPress = (): void => {
        if (held.current) {
          close()
        }
      }
      const onKey = (key: KeyboardEvent): void => {
        if (key.key === 'Escape') {
          onPress()
        }
      }
      document.addEventListener('pointermove', onMove, {
        capture: true,
        passive: true
      })
      document.addEventListener('pointerdown', onPress, true)
      document.addEventListener('keydown', onKey, true)
      untrack.current = () => {
        document.removeEventListener('pointermove', onMove, { capture: true })
        document.removeEventListener('pointerdown', onPress, true)
        document.removeEventListener('keydown', onKey, true)
      }
    },
    [open, close]
  )

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        const row = triggerNode.current
        const panel = row?.closest(SIDE_PANEL)
        // Side "left" offsets from the row, so the gap to the panel's edge includes the row's inset.
        setSideOffset(
          row && panel
            ? Math.max(0, row.getBoundingClientRect().left - panel.getBoundingClientRect().left) +
                PANEL_GAP
            : PANEL_GAP
        )
        setOpen(true)
        return
      }
      const card = cardNode.current?.getBoundingClientRect()
      if (
        exit.current &&
        pointer.current &&
        card &&
        inRowCardGraceArea(pointer.current, exit.current, card)
      ) {
        held.current = true
        return
      }
      close()
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
      side: 'left',
      align: 'start',
      sideOffset,
      collisionPadding: 8
    }
  }
}
