import React from 'react'
import { createPortal } from 'react-dom'
import { Popper, Presence } from 'radix-ui/internal'
import { usePortalContainer } from '@/components/ui/portal-container-context'
import { selectAppRailVisible } from '@/components/app-rail/app-rail-layout'
import { useAppStore } from '@/store'

type WorkspaceBoardMovedHintProps = {
  id: string
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}

// Why not a Tooltip: a Tooltip's DismissableLayer preventDefaults every Escape in the app while it is the
// top layer. Popper + Presence give the same placement and exit animation with no key or pointer handling.
export function WorkspaceBoardMovedHint({
  id,
  open,
  anchorRef,
  children
}: WorkspaceBoardMovedHintProps): React.JSX.Element {
  const container = usePortalContainer()
  const [sidebarLeft, setSidebarLeft] = React.useState(0)
  // Toggling the app rail moves the sidebar without a window resize, so it re-measures too.
  const appRailVisible = useAppStore(selectAppRailVisible)

  React.useLayoutEffect(() => {
    if (!open) {
      return
    }
    // The bubble may overhang the sidebar's right edge like the hover label, but never its left edge
    // (the app rail, when shown, sits left of it).
    const measure = (): void => {
      const shell = anchorRef.current?.closest('[data-sidebar-content-shell]')
      setSidebarLeft(Math.max(0, Math.round(shell?.getBoundingClientRect().left ?? 0)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [anchorRef, appRailVisible, open])

  return (
    <Popper.Root>
      <Popper.Anchor virtualRef={anchorRef} />
      {createPortal(
        <Presence.Presence present={open}>
          <Popper.Content
            side="top"
            sideOffset={4}
            collisionPadding={{ left: sidebarLeft }}
            id={id}
            role="tooltip"
            data-workspace-board-moved-hint=""
            data-state={open ? 'open' : 'closed'}
            // Same look as TooltipContent's default variant; zoom and slide only when motion is allowed.
            className="pointer-events-none z-[90] w-fit max-w-(--radix-popper-available-width) origin-(--radix-popper-transform-origin) rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background animate-in fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95"
          >
            {children}
            <Popper.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
          </Popper.Content>
        </Presence.Presence>,
        container ?? document.body
      )}
    </Popper.Root>
  )
}
