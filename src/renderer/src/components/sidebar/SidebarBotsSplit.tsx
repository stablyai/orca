import React, { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import {
  SIDEBAR_BOTS_MIN_HEIGHT,
  SIDEBAR_PROJECTS_MIN_LIST_HEIGHT,
  computeSidebarBotsMaxHeight
} from '../../../../shared/sidebar-bots-height'

// The hook's numeric size; 0 renders the class's default 40% cap.
const DEFAULT_CAP = 0
const PROJECTS_LIST_SELECTOR = ':scope > [data-sidebar-projects-list]'
// Classic scrollbars would widen a list's rows whenever the split lets it stop overflowing.
const SPLIT_SCROLL_GUTTER = '[&_.worktree-sidebar-scrollbar]:[scrollbar-gutter:stable]'

/** Tallest the Bots section may be dragged right now, from the Projects list's live height. */
export function measureSidebarBotsMaxHeight(section: HTMLElement): number {
  const list = section.parentElement?.querySelector<HTMLElement>(PROJECTS_LIST_SELECTOR)
  return computeSidebarBotsMaxHeight(section.offsetHeight, list?.offsetHeight ?? Infinity)
}

const SPLIT_SELECTOR = '[data-sidebar-bots-split]'
const SEARCH_HOLD_ATTRIBUTE = 'data-bots-search-hold'

function applyBotsCap(section: HTMLElement, size: number): void {
  section.style.maxHeight = size > DEFAULT_CAP ? `${size}px` : ''
}

/** A resize the user is making while search holds the height moves the hold with it. */
function applyUserResize(section: HTMLElement, size: number): void {
  applyBotsCap(section, size)
  if (size > DEFAULT_CAP && section.hasAttribute(SEARCH_HOLD_ATTRIBUTE)) {
    section.style.height = `${size}px`
  }
}

/** A user resize in progress: what to put back if it ends with no visible change. */
type ResizeStart = { height: number; hold: string }

/** Holds the Bots section at the height search opened with, so neither the field's results nor an
 *  empty state resizes it or moves Projects. Returns the release, which hands height back to content.
 *  One layout read per open; nothing runs per keystroke. */
export function holdSidebarBotsHeightForSearch(inside: Element): () => void {
  const section = inside.closest<HTMLElement>(SPLIT_SELECTOR)
  if (!section) {
    return () => {}
  }
  section.style.height = `${section.offsetHeight}px`
  section.setAttribute(SEARCH_HOLD_ATTRIBUTE, '')
  return () => {
    section.removeAttribute(SEARCH_HOLD_ATTRIBUTE)
    section.style.height = ''
  }
}

/** Holds the Projects list under a dragged Bots section; its min height makes Bots shrink first in flex layout. */
export function SidebarProjectsListSlot({
  botsShown,
  collapsed = false,
  children
}: {
  botsShown: boolean
  /** Hidden, not unmounted, so the list keeps its scroll and open dialogs. */
  collapsed?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-sidebar-projects-list=""
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        botsShown && SPLIT_SCROLL_GUTTER,
        collapsed && 'hidden'
      )}
      style={botsShown ? { minHeight: SIDEBAR_PROJECTS_MIN_LIST_HEIGHT } : undefined}
    >
      {children}
    </div>
  )
}

/** Wraps the Bots section so the seam above Projects drags to split the sidebar height.
 * Flex shrink (not a measured budget) keeps the Projects minimum when fixed rows or the window change. */
export function SidebarBotsSplit({
  projectsCollapsed = false,
  children
}: {
  /** Folded Projects leaves Bots the whole height, with no seam to drag. */
  projectsCollapsed?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const savedHeight = useAppStore((s) => s.sidebarBotsHeight)
  const setSidebarBotsHeight = useAppStore((s) => s.setSidebarBotsHeight)
  const collapsed = useAppStore((s) => s.collapsedGroups.has(BOTS_GROUP_KEY))
  const fillsSidebar = projectsCollapsed && !collapsed
  // Set from drag start until the drag ends: only then do applied sizes move the search hold.
  const dragRef = useRef<ResizeStart | null>(null)

  const { containerRef, onResizeStart, isResizing } = useSidebarResize<HTMLDivElement>({
    axis: 'y',
    isOpen: true,
    width: fillsSidebar ? DEFAULT_CAP : (savedHeight ?? DEFAULT_CAP),
    minWidth: SIDEBAR_BOTS_MIN_HEIGHT,
    maxWidth: Infinity,
    deltaSign: 1,
    // While search holds the height, onResizeEnd settles every drag, including one ending at the saved cap.
    setWidth: (nextHeight) => {
      if (!containerRef.current?.hasAttribute(SEARCH_HOLD_ATTRIBUTE)) {
        setSidebarBotsHeight(nextHeight)
      }
    },
    measureStartSize: (section) => {
      dragRef.current = { height: section.offsetHeight, hold: section.style.height }
      return dragRef.current.height
    },
    measureMaxSize: measureSidebarBotsMaxHeight,
    applyRenderedSize: (section, size) =>
      dragRef.current ? applyUserResize(section, size) : applyBotsCap(section, size),
    onResizeEnd: (movedTo) => {
      const start = dragRef.current
      dragRef.current = null
      const section = containerRef.current
      if (!start || !section?.hasAttribute(SEARCH_HOLD_ATTRIBUTE)) {
        return
      }
      if (movedTo === null) {
        // Back where it started: the hook put the saved cap back; put the opening hold back too.
        section.style.height = start.hold
        return
      }
      persistResize(movedTo, start)
    }
  })

  function persistResize(nextHeight: number, start: ResizeStart): void {
    const section = containerRef.current
    if (!section?.hasAttribute(SEARCH_HOLD_ATTRIBUTE)) {
      setSidebarBotsHeight(nextHeight)
      return
    }
    const renderedHeight = section.offsetHeight
    if (renderedHeight === start.height) {
      // A search-floor-masked resize must not change the cap restored when search closes, nor the hold.
      applyBotsCap(section, savedHeight ?? DEFAULT_CAP)
      section.style.height = start.hold
      return
    }
    // The floor can render taller than asked; hold what shows, and save it.
    section.style.height = `${renderedHeight}px`
    setSidebarBotsHeight(renderedHeight)
  }

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      // The drag overlay covers the handle after the first press, so onDoubleClick never fires.
      if (event.detail >= 2) {
        event.preventDefault()
        setSidebarBotsHeight(null)
        return
      }
      onResizeStart(event)
    },
    [onResizeStart, setSidebarBotsHeight]
  )

  return (
    // min-h-12 keeps the Bots header and its gap when a short sidebar shrinks the section.
    // While Bots search is open the section keeps room for the field and one or two rows,
    // and holds the height it opened with (holdSidebarBotsHeightForSearch).
    // The border is the Bots/Projects divider, drawn whether or not the seam can be dragged.
    // pb-2 matches the Projects header's mt-2; the sidebar viewport's 4px right padding is bled over to its edge.
    <div
      ref={containerRef}
      data-sidebar-bots-split=""
      className={cn(
        'relative flex min-h-12 scroll-mb-1 flex-col border-b border-worktree-sidebar-border pb-2',
        '[[data-sidebar-content-viewport]>&]:-mr-1 [[data-sidebar-content-viewport]>&]:pr-1',
        'has-[[data-bot-sidebar-search=single-row]]:min-h-34 has-[[data-bot-sidebar-search=multiple-rows]]:min-h-47',
        SPLIT_SCROLL_GUTTER,
        fillsSidebar ? 'flex-1' : 'max-h-[40%]'
      )}
    >
      {children}
      {collapsed || projectsCollapsed ? null : (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-valuenow={savedHeight ?? SIDEBAR_BOTS_MIN_HEIGHT}
          aria-label={t('sidebar.botsSplit.resize', 'Resize bots and projects')}
          data-sidebar-bots-resize-handle=""
          className={cn(
            'group absolute inset-x-0 -bottom-1 z-10 h-2 scroll-my-0.5 cursor-row-resize outline-none focus-visible:bg-ring/10',
            isResizing && 'bg-ring/10'
          )}
          onMouseDown={startResize}
          onFocus={(event) => {
            event.currentTarget.setAttribute(
              'aria-valuenow',
              String(containerRef.current?.offsetHeight)
            )
            event.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'instant' })
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
              return
            }
            event.preventDefault()
            const section = containerRef.current
            if (!section) {
              return
            }
            const height = section.offsetHeight
            const minimum = Math.max(
              SIDEBAR_BOTS_MIN_HEIGHT,
              Number.parseFloat(getComputedStyle(section).minHeight) || 0
            )
            const nextHeight = Math.max(
              minimum,
              Math.min(
                measureSidebarBotsMaxHeight(section),
                height + (event.key === 'ArrowDown' ? 8 : -8)
              )
            )
            const start = { height, hold: section.style.height }
            applyUserResize(section, nextHeight)
            persistResize(nextHeight, start)
            event.currentTarget.setAttribute('aria-valuenow', String(section.offsetHeight))
            event.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'instant' })
          }}
        >
          {/* Sits on the section's bottom border so hover recolors the divider instead of adding a second line.
              The handle is placed from the padding box, so the border pixel is 3px above its bottom edge, not 4px.
              Opaque sidebar ring on hover: a translucent one barely shifts the divider, and tinted sidebars override it. */}
          <div className="absolute inset-x-0 bottom-0.75 h-px bg-transparent transition-colors group-hover:bg-worktree-sidebar-ring group-active:bg-worktree-sidebar-ring group-focus-visible:bg-worktree-sidebar-ring" />
        </div>
      )}
    </div>
  )
}
