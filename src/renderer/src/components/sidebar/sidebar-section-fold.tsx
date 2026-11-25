import React from 'react'
import { flushSync } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { readPrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import './sidebar-section-fold.css'

const WORKSPACES_HEADER_SELECTOR =
  '[data-sidebar-section-header="projects"], [data-sidebar-section-header="workspaces"]'
const WORKSPACES_SHIFT = '--sidebar-fold-workspaces-shift'
const activeFolds = new WeakMap<HTMLElement, ViewTransition>()

// TypeScript's DOM library has the document API but not Chromium's element-scoped variant.
type SidebarFoldViewport = HTMLElement & { startViewTransition?: Document['startViewTransition'] }

/** Animates a user fold without delaying programmatic reveals or resizing live list viewports. */
export function animateSidebarSectionFold(control: HTMLElement, toggle: () => void): void {
  const viewport = control.closest<SidebarFoldViewport>('[data-sidebar-content-viewport]')
  if (
    !viewport?.startViewTransition ||
    viewport.ownerDocument.hidden ||
    readPrefersReducedMotion()
  ) {
    toggle()
    return
  }

  const workspacesHeader = control.closest(WORKSPACES_HEADER_SELECTOR)
  const transition = viewport.startViewTransition({
    types: ['sidebar-fold'],
    update: () => {
      const before = workspacesHeader?.getBoundingClientRect().top
      flushSync(toggle)
      if (activeFolds.get(viewport) === transition && workspacesHeader && before !== undefined) {
        viewport.style.setProperty(
          WORKSPACES_SHIFT,
          `${workspacesHeader.getBoundingClientRect().top - before}px`
        )
      }
    }
  })
  activeFolds.set(viewport, transition)
  void transition.ready.catch((error: unknown) => {
    if (error instanceof DOMException && ['AbortError', 'InvalidStateError'].includes(error.name)) {
      return
    }
    throw error
  })
  void transition.finished.finally(() => {
    if (activeFolds.get(viewport) === transition) {
      viewport.style.removeProperty(WORKSPACES_SHIFT)
      activeFolds.delete(viewport)
    }
  })
}

/** The fold arrow of a top-level sidebar section header; it lights up with the header's `peer` fold button. */
export function SidebarSectionFoldChevron({
  collapsed
}: {
  collapsed: boolean
}): React.JSX.Element {
  return (
    <span className="pointer-events-none ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors peer-hover:bg-accent/70 peer-hover:text-foreground">
      <ChevronDown
        className={cn(
          'size-3.5 transition-transform motion-reduce:transition-none',
          collapsed && '-rotate-90'
        )}
      />
    </span>
  )
}
