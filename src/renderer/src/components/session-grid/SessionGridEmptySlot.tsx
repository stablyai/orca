import React, { useCallback, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import type { SessionGridFilter } from '../../../../shared/session-grid-types'
import type { SessionGridWorktreeCatalog } from './session-grid-worktree-catalog'
import { SessionGridLaunchPopoverContent } from './SessionGridLaunchPicker'
import { translate } from '@/i18n/i18n'

/** A vacant grid cell: the whole card opens the launch menu, anchored at the click. */
export function SessionGridEmptySlot({
  activeFilter,
  defaultWorktreeId,
  worktreeCatalog,
  gridWorktreeIds
}: {
  activeFilter: SessionGridFilter
  defaultWorktreeId?: string
  worktreeCatalog: SessionGridWorktreeCatalog
  gridWorktreeIds: readonly string[]
}): React.JSX.Element {
  const cardRef = useRef<HTMLButtonElement | null>(null)
  const openRef = useRef(false)
  const wasOpenOnPointerDownRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ x: 0, y: 0 })

  const handleOpenChange = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
  }, [])

  // The card is no longer the trigger, so Radix dismisses on this very pointerdown and the
  // click that follows would reopen it. Remember what the click started on top of.
  const notePointerDown = useCallback(() => {
    wasOpenOnPointerDownRef.current = openRef.current
  }, [])

  const openAtPointer = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (wasOpenOnPointerDownRef.current) {
        wasOpenOnPointerDownRef.current = false
        handleOpenChange(false)
        return
      }
      // A keyboard activation reports (0, 0); anchor those to the card itself.
      const rect = event.currentTarget.getBoundingClientRect()
      const isPointerClick = event.clientX !== 0 || event.clientY !== 0
      setPoint(
        isPointerClick
          ? { x: event.clientX, y: event.clientY }
          : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      )
      handleOpenChange(true)
    },
    [handleOpenChange]
  )

  const restoreCardFocus = useCallback((event: Event) => {
    // The 1px anchor is not the thing the user was on; hand focus back to the card.
    event.preventDefault()
    cardRef.current?.focus()
  }, [])
  const closeMenu = useCallback(() => handleOpenChange(false), [handleOpenChange])

  return (
    <>
      {/* Why the card and not an inner button: a wrapper that forwarded clicks to
          an inner trigger re-toggled the menu shut when the click started on the
          button itself, so "New Session" did nothing. */}
      <button
        ref={cardRef}
        type="button"
        data-testid="session-grid-empty-slot"
        onPointerDown={notePointerDown}
        onClick={openAtPointer}
        className="group flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/20 p-4 transition-all duration-150 hover:border-border hover:bg-card/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="flex size-9 items-center justify-center rounded-full bg-muted/50 text-muted-foreground transition-all duration-150 group-hover:bg-accent group-hover:text-foreground">
          <Plus className="size-4" />
        </div>
        <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground">
          {translate('auto.components.session.grid.SessionGridEmptySlot.dbcddec0c0', 'New session')}
        </span>
        <span className="text-[11px] text-muted-foreground/60">
          {translate(
            'auto.components.session.grid.SessionGridEmptySlot.ad86c2342f',
            'Launch a terminal or agent here'
          )}
        </span>
      </button>
      <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
        {/* Anchoring to the card's bounding box put the menu far from the click and
            flipped sides on the last row; anchor to the click point instead. */}
        <PopoverTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: point.x, top: point.y }}
          />
        </PopoverTrigger>
        <SessionGridLaunchPopoverContent
          activeFilter={activeFilter}
          {...(defaultWorktreeId ? { defaultWorktreeId } : {})}
          worktreeCatalog={worktreeCatalog}
          gridWorktreeIds={gridWorktreeIds}
          onDone={closeMenu}
          align="start"
          sideOffset={0}
          onCloseAutoFocus={restoreCardFocus}
        />
      </Popover>
    </>
  )
}
