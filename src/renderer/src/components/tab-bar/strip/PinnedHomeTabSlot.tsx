import React from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { TabStripDensityContext, TITLED_TAB_STRIP_DENSITY } from './tab-strip-density-context'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

/** A bot's Home in its own slot left of the strip: outside its scroll and condense plan, so it never moves or hides. */
export function PinnedHomeTabSlot({
  sortableIds,
  singleTab,
  withStrip,
  narrowHideClassName,
  children
}: {
  sortableIds: string[]
  singleTab: boolean
  /** Other tabs share the bar, hidden ones included. */
  withStrip: boolean
  /** Hides the slot below a width where the plan always shows the +N chip, whose list leads with Home. */
  narrowHideClassName: string
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
        // Narrowest panes: Home's width follows the pane width, never the flex result, so it can't feed back into the condense plan.
        // At <=86px Home is a fixed 32px icon so the +N chip stays whole; narrower still it hides once the +N list (which leads with Home) is sure to exist.
        className={`@container/pinned-home group/tab-strip flex min-h-0 min-w-10 @max-[86px]/tab-strip:min-w-8 @max-[86px]/tab-strip:basis-8 @max-[86px]/tab-strip:shrink-0 shrink grow-0 basis-[144px] overflow-hidden [&>[data-tab-strip-slot]]:w-full [&>[data-tab-strip-slot]]:max-w-none [&>[data-tab-strip-slot]]:min-w-0 @max-[114px]/pinned-home:[&_.tab-label]:sr-only @max-[74px]/pinned-home:[&_[data-tab-color-dot]]:hidden @max-[60px]/pinned-home:[&_.lucide-pin]:hidden ${narrowHideClassName}`}
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
