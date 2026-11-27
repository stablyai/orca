import React, { createContext, useCallback, useContext, useRef } from 'react'
import { useComposedRefs } from 'radix-ui/internal'
import { cn } from '@/lib/class-names'

/**
 * One frame for every rail page (Tasks, Automations, Artifacts, Skills): an inset surface with a 52px header band,
 * an optional 42px toolbar band, an optional notice band and the page's own body. Narrow (page under 640px) is a
 * container query only, so a resize never re-parents a control or drops focus.
 *
 * `--rail-page-gutter` is the one side edge every band, row and hairline lines up with (24px; 16px narrow).
 * Scrollers are never padded: rows pad themselves from the variable, so sticky cells and hairlines stay aligned.
 */

const RailPageContext = createContext<React.RefObject<HTMLElement | null> | null>(null)

export function useRailPageRoot(): React.RefObject<HTMLElement | null> | null {
  return useContext(RailPageContext)
}

export const RAIL_PAGE_GUTTER_X = 'px-(--rail-page-gutter)'

function trackRailPageScrollGutter(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return
  }
  const widthProperty = '--rail-page-scrollbar-width'
  let currentScrollbarWidth = element.style.getPropertyValue(widthProperty) || '0px'
  const measure = (): void => {
    const { borderLeftWidth, borderRightWidth } = getComputedStyle(element)
    const borders = Number.parseFloat(borderLeftWidth) + Number.parseFloat(borderRightWidth)
    const scrollbarWidth = `${Math.max(0, element.offsetWidth - element.clientWidth - borders)}px`
    if (scrollbarWidth !== currentScrollbarWidth) {
      currentScrollbarWidth = scrollbarWidth
      element.style.setProperty(widthProperty, scrollbarWidth)
    }
  }
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  return () => observer.disconnect()
}

export function RailPageScroll({
  as: Element = 'div',
  containerGutter = false,
  ref,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section'
  containerGutter?: boolean
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const scrollRef = useComposedRefs<HTMLDivElement>(
    ref,
    containerGutter ? undefined : trackRailPageScrollGutter
  )
  return (
    <Element
      ref={scrollRef}
      className={cn('rail-page-scroll-region', className)}
      data-rail-page-container-gutter={containerGutter ? '' : undefined}
      {...props}
    />
  )
}

export function RailPage({
  children,
  className,
  as: Root = 'div',
  ...props
}: {
  children: React.ReactNode
  className?: string
  as?: 'div' | 'main'
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null)
  const attachRoot = useCallback((element: HTMLElement | null) => {
    rootRef.current = element
  }, [])
  return (
    <RailPageContext.Provider value={rootRef}>
      {/* Why a wrapper: an element can't query its own width, and the page column also holds the inert terminal
          workbench, so containment must not go on the column. */}
      <div className="rail-page-container flex h-full min-h-0 min-w-0 flex-1 flex-col bg-worktree-sidebar">
        <Root
          ref={attachRoot}
          data-rail-page=""
          className={cn(
            'relative mr-2 mb-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xs',
            '[--rail-page-gutter:24px] @max-[40rem]/rail-page:[--rail-page-gutter:16px] [--list-table-gutter:var(--rail-page-gutter)]',
            '@max-[40rem]/rail-page:m-0 @max-[40rem]/rail-page:rounded-none @max-[40rem]/rail-page:border-r-0 @max-[40rem]/rail-page:border-b-0 @max-[40rem]/rail-page:shadow-none',
            className
          )}
          {...props}
        >
          {children}
        </Root>
      </div>
    </RailPageContext.Provider>
  )
}

/** The page's own content below the bands. Never scrolls itself: each list keeps its scroller (D1 B4). */
export function RailPageBody({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>{children}</div>
}

/** Banners and active-filter pills between the toolbar and the list, on the page's side edges. */
export function RailPageNotice({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element | null {
  if (children === null || children === undefined || children === false) {
    return null
  }
  return (
    <div className={cn('flex shrink-0 flex-col gap-2 py-2', RAIL_PAGE_GUTTER_X, className)}>
      {children}
    </div>
  )
}
