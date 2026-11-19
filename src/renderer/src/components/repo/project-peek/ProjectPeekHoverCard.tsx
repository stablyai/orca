import React from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { ProjectPeek, type ProjectPeekMode } from './ProjectPeek'

// Why: the content portals out of the DOM but React still bubbles its events to the card underneath,
// which would select, drag, or rename the workspace on every edit click.
const stopPropagation = (event: React.SyntheticEvent): void => event.stopPropagation()

const OPEN_DELAY_MS = 350

// Why: the card portals to the end of the document, so native Tab order would leave it for the
// app chrome; keep keyboard focus cycling through the card's own controls.
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

export function ProjectPeekHoverCard({
  repo,
  children,
  onOpenChange
}: {
  repo: Repo
  children: React.ReactElement
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpenState] = React.useState(false)
  const [mode, setMode] = React.useState<ProjectPeekMode>('info')
  const modeRef = React.useRef<ProjectPeekMode>('info')
  const explicitDismissRef = React.useRef(false)
  const openTimerRef = React.useRef<number | undefined>(undefined)

  const changeMode = React.useCallback((next: ProjectPeekMode) => {
    modeRef.current = next
    setMode(next)
  }, [])
  const setOpen = React.useCallback(
    (next: boolean) => {
      window.clearTimeout(openTimerRef.current)
      const explicit = explicitDismissRef.current
      explicitDismissRef.current = false
      // Why: editing pins the card; a stray pointer exit mid-pick must not end the session.
      if (!next && modeRef.current === 'edit' && !explicit) {
        return
      }
      if (!next) {
        changeMode('info')
      }
      setOpenState(next)
      onOpenChange?.(next)
    },
    [changeMode, onOpenChange]
  )
  React.useEffect(() => () => window.clearTimeout(openTimerRef.current), [])

  const contentRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLAnchorElement>(null)
  // Why: some panes (terminals) stop pointerdown before Radix's outside-press listener sees it,
  // which would strand a pinned editor; capture at the window so any outside press ends editing.
  React.useEffect(() => {
    if (!open || mode !== 'edit') {
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
      explicitDismissRef.current = true
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, mode, setOpen])

  const requestClose = React.useCallback(() => {
    explicitDismissRef.current = true
    setOpen(false)
  }, [setOpen])

  const focusOnOpenRef = React.useRef(false)
  const openInEditMode = (): void => {
    changeMode('edit')
    focusOnOpenRef.current = true
    setOpen(true)
  }
  // Why: a pinned card opened by click or Enter takes focus so keyboard users can Tab through it.
  React.useEffect(() => {
    if (!open || !focusOnOpenRef.current) {
      return
    }
    focusOnOpenRef.current = false
    const frame = window.requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('button[aria-pressed]')?.focus()
    )
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  return (
    <HoverCard open={open} closeDelay={150} onOpenChange={setOpen}>
      <HoverCardTrigger
        ref={triggerRef}
        asChild
        // Why: a host card's hover intent preventDefaults the shared pointerenter, which would
        // stop Radix from ever opening this nested card, so the open delay is owned here.
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch' || open) {
            return
          }
          window.clearTimeout(openTimerRef.current)
          openTimerRef.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS)
        }}
        onPointerLeave={() => window.clearTimeout(openTimerRef.current)}
        // Clicking the mark is the direct route to customizing it, and keeps the workspace unselected.
        onClick={(event) => {
          event.stopPropagation()
          openInEditMode()
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        ref={contentRef}
        variant="project-peek"
        side="right"
        align="start"
        sideOffset={8}
        // Why: marks the card as a row control so a host card's details hover stands down while it's used.
        data-activity-thread-control=""
        onPointerDownOutside={() => {
          explicitDismissRef.current = true
        }}
        onEscapeKeyDown={() => {
          explicitDismissRef.current = true
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
        <ProjectPeek
          repo={repo}
          mode={mode}
          onModeChange={changeMode}
          onRequestClose={requestClose}
        />
      </HoverCardContent>
    </HoverCard>
  )
}
