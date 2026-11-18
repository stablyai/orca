// One section of a bot's panel: a heading lined up with the rows' icons, over a card of rows.
import { useId } from 'react'
import { cn } from '@/lib/class-names'
import type { BotPanelFold } from './use-bot-panel-fold'
import { BotFoldChevron } from './BotFoldChevron'

/** A card's border and fill; `warning` tints it for what only the owner can move. */
export function botPanelCardSurface(tone?: 'warning'): string {
  return cn(
    'rounded-lg border p-1',
    tone === 'warning'
      ? 'border-status-warning-border bg-status-warning-background'
      : 'border-border bg-card dark:bg-secondary/50'
  )
}

export function BotPanelCard({
  title,
  count,
  action,
  stacked = false,
  fold,
  className,
  ref,
  children
}: {
  title: string
  /** How many rows count, after the title; none for 0 or absent. */
  count?: number
  /** Controls at the heading's end, such as a button that adds a row. */
  action?: React.ReactNode
  /** Each child is its own card (see `botPanelCardSurface`), with a gap between them. */
  stacked?: boolean
  /** The heading folds the card. */
  fold?: BotPanelFold
  className?: string
  ref?: React.Ref<HTMLElement>
  children: React.ReactNode
}): React.JSX.Element {
  const bodyId = useId()
  const open = fold?.open ?? true
  const label = (
    <>
      <span className="truncate">{title}</span>
      {count ? (
        <span aria-hidden className="font-normal text-muted-foreground tabular-nums">
          {count}
        </span>
      ) : null}
    </>
  )
  return (
    <section ref={ref} className={cn('flex flex-col gap-1', className)}>
      {/* Card border 1px + card padding 4px + row padding 8px: the heading starts where row icons do. */}
      <div className="flex min-h-6 items-center justify-between gap-2 pr-[9px] pl-[13px]">
        <h3 className="flex min-w-0 items-center text-xs font-semibold text-foreground">
          {fold ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => fold.onOpenChange(!open)}
              className="group/fold flex min-h-6 min-w-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {label}
              <BotFoldChevron open={open} className="size-3 group-hover/fold:text-foreground" />
            </button>
          ) : (
            <span className="flex min-h-6 items-center gap-1">{label}</span>
          )}
        </h3>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {open ? (
        <div
          id={bodyId}
          className={cn('flex flex-col', stacked ? 'gap-1.5' : botPanelCardSurface())}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}
