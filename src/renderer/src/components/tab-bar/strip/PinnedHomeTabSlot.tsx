import React from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

/** A bot's Home in its own slot left of the strip: outside its scroll, so it never moves or scrolls away. */
export function PinnedHomeTabSlot({
  sortableIds,
  singleTab,
  withStrip,
  children
}: {
  sortableIds: string[]
  singleTab: boolean
  /** Other tabs share the bar. */
  withStrip: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Its own context: the windowed strip leaves Home out, and Home still takes drops after it.
    <SortableContext items={sortableIds}>
      <div
        data-single-tab={singleTab ? '' : undefined}
        data-pinned-home-slot=""
        // Read by the pane header: with side tabs beside it, Home adds a second 40px floor its action budget must keep.
        data-pinned-home-with-strip={withStrip ? '' : undefined}
        // Why: Home keeps its usual 144px while the strip beside it shrinks and scrolls; narrower, Home drops its label
        // (hidden whole once it no longer fits), then its color dot, down to the usual 40px tab floor.
        // The tab fills this box, so the drop marker on its right edge is never clipped; sr-only keeps "Home" as the accessible name.
        // Thresholds: 114 = 84 idle titled tab + 16 working/unread dot + 14 color dot; 74 = 44 icon tab + 16 + 14.
        className="@container/pinned-home group/tab-strip flex min-h-0 min-w-10 shrink grow-0 basis-[144px] overflow-hidden [&>[data-tab-strip-slot]]:w-full [&>[data-tab-strip-slot]]:max-w-none [&>[data-tab-strip-slot]]:min-w-0 @max-[114px]/pinned-home:[&_.tab-label]:sr-only @max-[74px]/pinned-home:[&_[data-tab-color-dot]]:hidden"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <TabStripTooltipProvider>{children}</TabStripTooltipProvider>
      </div>
    </SortableContext>
  )
}
