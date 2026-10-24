import type React from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { CMD_J_PALETTE_VIEWS, getCmdJPaletteViewLabel, type CmdJPaletteView } from './palette-view'

export default function PaletteViewSwitcher({
  view,
  onViewChange,
  counts
}: {
  view: CmdJPaletteView
  onViewChange: (view: CmdJPaletteView) => void
  /** Per-view match counts while a query is typed; null hides them. */
  counts: Record<CmdJPaletteView, number> | null
}): React.JSX.Element {
  return (
    <div className="mx-3 mt-2 mb-1 border-b border-border/60">
      <Tabs
        value={view}
        onValueChange={(next) => {
          const nextView = CMD_J_PALETTE_VIEWS.find((candidate) => candidate === next)
          if (nextView) {
            onViewChange(nextView)
          }
        }}
      >
        <TabsList
          variant="line"
          size="sm"
          aria-label={translate('worktreeJumpPalette.view.ariaLabel', 'Result type')}
          className="w-full justify-start"
        >
          {CMD_J_PALETTE_VIEWS.map((candidate) => (
            <TabsTrigger
              key={candidate}
              value={candidate}
              // Why switch here: preventing mousedown keeps the caret in the search field but also
              // skips Radix's own mousedown activation.
              tabIndex={-1}
              onMouseDown={(event) => {
                event.preventDefault()
                if (event.button === 0) {
                  onViewChange(candidate)
                }
              }}
              className="flex-none"
            >
              <span>{getCmdJPaletteViewLabel(candidate)}</span>
              {counts ? (
                <span
                  className={cn(
                    'text-3xs tabular-nums text-muted-foreground in-data-[state=active]:text-foreground/70',
                    counts[candidate] === 0 && 'text-muted-foreground/50'
                  )}
                >
                  {counts[candidate]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}
