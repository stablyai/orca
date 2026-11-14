import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'

/** One column for every Automations page: the header and the body share width and gutter. */
export const AUTOMATIONS_PAGE_CONTAINER_CLASS = 'mx-auto w-full max-w-[1080px] px-4 md:px-6'

/** Page-wide notices (an owner conflict) that every sub-page shows above its content. */
export const AutomationsPageNoticeContext = createContext<React.ReactNode>(null)

// Below this header width, secondary header actions fold into the overflow menu.
const COMPACT_HEADER_WIDTH_PX = 576

function useIsNarrowerThan(ref: React.RefObject<HTMLElement | null>, widthPx: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const measure = (): void => {
      const next = element.getBoundingClientRect().width < widthPx
      setNarrow((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, widthPx])
  return narrow
}

export function AutomationsPageFrame({
  nav,
  actions,
  notice,
  bodyScroll = 'page',
  children
}: {
  nav: React.ReactNode
  /** Rendered at the header's trailing edge; `compact` asks for a folded set. */
  actions?: (layout: { compact: boolean }) => React.ReactNode
  /** Page-level notices that sit above the content, inside the shared column. */
  notice?: React.ReactNode
  /** 'page' scrolls the whole body; 'content' lets a list inside own its scrolling. */
  bodyScroll?: 'page' | 'content'
  children: React.ReactNode
}): React.JSX.Element {
  const headerRef = useRef<HTMLDivElement>(null)
  const compact = useIsNarrowerThan(headerRef, COMPACT_HEADER_WIDTH_PX)
  const pageNotice = useContext(AutomationsPageNoticeContext)
  return (
    <>
      <header
        className="shrink-0 border-b border-border/60"
        style={{ paddingRight: 'var(--window-controls-width, 0px)' }}
      >
        <div
          ref={headerRef}
          className={cn(AUTOMATIONS_PAGE_CONTAINER_CLASS, 'flex min-h-12 items-center gap-3')}
        >
          <div className="flex min-w-0 flex-1 items-center">{nav}</div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions({ compact })}</div>
          ) : null}
        </div>
      </header>
      {bodyScroll === 'page' ? (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          <div className={cn(AUTOMATIONS_PAGE_CONTAINER_CLASS, 'pb-10')}>
            {pageNotice}
            {notice}
            {children}
          </div>
        </div>
      ) : (
        <div className={cn(AUTOMATIONS_PAGE_CONTAINER_CLASS, 'flex min-h-0 flex-1 flex-col pb-4')}>
          {pageNotice}
          {notice}
          {children}
        </div>
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
