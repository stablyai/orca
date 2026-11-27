import React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { ProjectPeek } from './ProjectPeek'

// Why: the content portals out of the DOM but React still bubbles its events to the card underneath,
// which would select, drag, or rename the workspace on every edit click.
const stopPropagation = (event: React.SyntheticEvent): void => event.stopPropagation()

// Why: the popover portals to the end of the document, so native Tab order would leave it for the
// app chrome; keep keyboard focus cycling through the popover's own controls.
function cycleFocus(event: React.KeyboardEvent, root: HTMLElement | null): void {
  const focusables = root
    ? Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input'))
    : []
  if (focusables.length === 0) {
    return
  }
  event.preventDefault()
  const active = document.activeElement
  const index = active instanceof HTMLElement ? focusables.indexOf(active) : -1
  const step = event.shiftKey ? -1 : 1
  focusables[(index + step + focusables.length) % focusables.length]?.focus()
}

/** Clicking a project's mark opens its card to change the icon and color. */
export function ProjectPeekPopover({
  repo,
  children,
  onOpenChange
}: {
  repo: Repo
  children: React.ReactElement
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpenState] = React.useState(false)
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )

  const contentRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  // Why: some panes (terminals) stop pointerdown before Radix's outside-press listener sees it,
  // which would strand the popover; capture at the window so any outside press closes it.
  React.useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        (contentRef.current?.contains(target) || triggerRef.current?.contains(target))
      ) {
        return
      }
      // The custom-color popover and tooltips portal out of the card but belong to it.
      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper]')) {
        return
      }
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, setOpen])

  const requestClose = React.useCallback(() => setOpen(false), [setOpen])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        asChild
        // Opening the card must not also select the workspace underneath.
        onClick={stopPropagation}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={8}
        className="w-[296px] max-w-[calc(100vw-2rem)]"
        // Why: marks the popover as a row control so a host card's details hover stands down while it's used.
        data-activity-thread-control=""
        // Why: Radix would focus the header action first; landing on the current style tab puts keys where editing starts.
        onOpenAutoFocus={(event) => {
          const tab = contentRef.current?.querySelector<HTMLElement>(
            '[role="tab"][data-state="active"]'
          )
          if (tab) {
            event.preventDefault()
            tab.focus({ preventScroll: true })
          }
        }}
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onMouseDown={stopPropagation}
        onMouseUp={stopPropagation}
        onClick={stopPropagation}
        onDoubleClick={stopPropagation}
        onContextMenu={stopPropagation}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Tab') {
            cycleFocus(event, contentRef.current)
          }
        }}
        onDragStart={stopPropagation}
      >
        <ProjectPeek repo={repo} onRequestClose={requestClose} />
      </PopoverContent>
    </Popover>
  )
}
