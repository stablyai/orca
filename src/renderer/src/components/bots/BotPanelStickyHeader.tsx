// A bot's Home header, pinned to the top of its scroller while the list scrolls under it. The scroller
// must be `relative` (the sentinel sits at its top) with a 12 px top padding (`py-3`) that the header
// keeps as its own, so it never moves as it pins: Chromium pins sticky boxes inside the scroller's
// padding, so `-top-3` pins it at the very top. Its 10 px bottom pad, taken back out of the list's
// 14 px gap, balances the pinned band without moving anything. A divider shows only while rows are under it.
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** For the list under the header: anything in it scrolled to (Tab, Back) lands below the pinned band
 *  (12 + 44 + 10 px) with 8 px of air, not under it. A margin on the list rather than the scroller's scroll-padding,
 *  which would scroll the list back to the top whenever a header control takes focus. */
export const BOT_PANEL_STICKY_HEADER_CLEARANCE = '[&_*]:scroll-mt-[74px]'

export function revealFocusBelowBotPanelHeader(control: HTMLElement, row = control): void {
  const header = row
    .closest('[data-bot-home-panel]')
    ?.querySelector(':scope > [data-bot-panel-sticky-header]')
  if (header && row.getBoundingClientRect().top < header.getBoundingClientRect().bottom) {
    control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

export function BotPanelStickyHeader({ children }: { children: ReactNode }): React.JSX.Element {
  const sentinel = useRef<HTMLDivElement | null>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const node = sentinel.current
    const root = node?.parentElement
    if (!node || !root || typeof IntersectionObserver === 'undefined') {
      return
    }
    // A zero-height sentinel stops intersecting on the first positive scroll offset.
    const observer = new IntersectionObserver(
      ([entry]) => setScrolledUnder(entry ? !entry.isIntersecting : false),
      { root }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <>
      <div
        ref={sentinel}
        aria-hidden
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0"
      />
      <div
        data-bot-panel-sticky-header=""
        data-scrolled-under={scrolledUnder ? '' : undefined}
        // The scroller's side padding stays its own (its left is the resize grab strip): the backdrop and
        // divider reach across it without taking its pointer events.
        className="sticky -top-3 z-10 -mt-3 -mb-2.5 pt-3 pb-2.5 before:pointer-events-none before:absolute before:inset-y-0 before:-left-3.5 before:-right-2 before:-z-10 before:bg-sidebar after:pointer-events-none after:absolute after:bottom-0 after:-left-3.5 after:-right-2 after:h-px after:bg-border/60 after:opacity-0 data-[scrolled-under]:after:opacity-100"
      >
        {children}
      </div>
    </>
  )
}
