import React, { createContext, useContext, useRef } from 'react'
import { cn } from '@/lib/class-names'
import { RAIL_PAGE_GUTTER_X, RailPageBody } from '@/components/rail-page/RailPage'
import { useIsNarrowerThan } from '@/components/rail-page/use-is-narrower-than'
import { RailPageBand } from '@/components/rail-page/RailPageHeader'

/**
 * One column for every Automations page: the header and the body share width and gutter.
 * Full width with no cap, so tables use wide and ultra-wide windows; the list's Name
 * column absorbs the extra space while the data columns keep their bounded widths.
 */
const AUTOMATIONS_PAGE_CONTAINER_CLASS = `w-full ${RAIL_PAGE_GUTTER_X}`

/** Page-wide notices (an owner conflict) that every sub-page shows above its content. */
export const AutomationsPageNoticeContext = createContext<React.ReactNode>(null)

// Below this header width, secondary header actions fold into the overflow menu.
export const COMPACT_HEADER_WIDTH_PX = 576

export function AutomationsPageFrame({
  nav,
  actions,
  notice,
  bodyScroll = 'page',
  compactBelowPx = COMPACT_HEADER_WIDTH_PX,
  children
}: {
  nav: React.ReactNode
  /** Rendered at the header's trailing edge; `compact` asks for a folded set. */
  actions?: (layout: { compact: boolean }) => React.ReactNode
  /** Page-level notices that sit above the content, inside the shared column. */
  notice?: React.ReactNode
  /** 'page' scrolls the whole body; 'content' lets a list inside own its scrolling. */
  bodyScroll?: 'page' | 'content'
  /** Header width under which `actions` fold; wider for a longer set of actions. */
  compactBelowPx?: number
  children: React.ReactNode
}): React.JSX.Element {
  const headerRef = useRef<HTMLDivElement>(null)
  const compact = useIsNarrowerThan(headerRef, compactBelowPx)
  const pageNotice = useContext(AutomationsPageNoticeContext)
  return (
    <>
      <RailPageBand>
        <div ref={headerRef} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center">{nav}</div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions({ compact })}</div>
          ) : null}
        </div>
      </RailPageBand>
      {bodyScroll === 'page' ? (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          <div className={cn(AUTOMATIONS_PAGE_CONTAINER_CLASS, 'pb-10')}>
            {pageNotice}
            {notice}
            {children}
          </div>
        </div>
      ) : (
        <RailPageBody className={cn(AUTOMATIONS_PAGE_CONTAINER_CLASS, 'pb-4')}>
          {pageNotice}
          {notice}
          {children}
        </RailPageBody>
      )}
    </>
  )
}

/** The page's heading; focused when the page opens so screen readers announce where they are. */
export function AutomationsPageTitle({
  children,
  title,
  className
}: {
  children: React.ReactNode
  /** Full text when the heading truncates. */
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <h2
      tabIndex={-1}
      data-automations-page-title=""
      title={title}
      className={cn(
        'min-w-0 truncate text-xl font-semibold tracking-tight outline-none',
        className
      )}
    >
      {children}
    </h2>
  )
}
