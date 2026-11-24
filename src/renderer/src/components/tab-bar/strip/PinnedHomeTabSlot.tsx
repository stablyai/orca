import React from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { TabStripDensityContext, TITLED_TAB_STRIP_DENSITY } from './tab-strip-density-context'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

/** A bot's Home in its own slot left of the strip: outside its scroll and condense plan, so it never moves or hides. */
export function PinnedHomeTabSlot({
  sortableIds,
  singleTab,
  withStrip,
  children
}: {
  sortableIds: string[]
  singleTab: boolean
  /** Other tabs share the bar, hidden ones included. */
  withStrip: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Its own context: the windowed strip leaves Home out, and Home still takes drops after it.
    <SortableContext items={sortableIds}>
      <div
        data-single-tab={singleTab ? '' : undefined}
        data-pinned-home-slot=""
        // The condense plan subtracts this slot from the strip's room.
        data-tab-strip-reserve=""
        // Read by the pane header: with side tabs beside it, Home adds a second 40px floor its action budget must keep.
        data-pinned-home-with-strip={withStrip ? '' : undefined}
        // Why: Home keeps its usual 144px while the strip condenses; once only the +N chip is left, Home narrows to its icons (label hidden once it no longer fits whole), then to its avatar on the usual 40px tab floor.
        // The tab fills this box, so the drop marker on its right edge is never clipped; sr-only keeps "Home" as the accessible name when it hides.
        // Widths and thresholds: PINNED_HOME_* in tab-strip-width-budget.ts (Tailwind needs the literals).
        className="@container/pinned-home group/tab-strip flex min-h-0 min-w-10 shrink grow-0 basis-[144px] overflow-hidden [&>[data-tab-strip-slot]]:w-full [&>[data-tab-strip-slot]]:max-w-none [&>[data-tab-strip-slot]]:min-w-0 @max-[114px]/pinned-home:[&_.tab-label]:sr-only @max-[74px]/pinned-home:[&_[data-tab-color-dot]]:hidden @max-[60px]/pinned-home:[&_.lucide-pin]:hidden"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Titled whatever the strip's plan: Home is never iconified by it or sized to its active width. */}
        <TabStripDensityContext value={TITLED_TAB_STRIP_DENSITY}>
          <TabStripTooltipProvider>{children}</TabStripTooltipProvider>
        </TabStripDensityContext>
      </div>
    </SortableContext>
  )
}
