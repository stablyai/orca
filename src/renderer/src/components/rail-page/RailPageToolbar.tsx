import React from 'react'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  RAIL_UNDERLINE_ITEM_CLASS,
  ToggleGroup,
  ToggleGroupItem
} from '@/components/ui/toggle-group'
import { toggleVariants } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { RAIL_PAGE_GUTTER_X } from './RailPage'
import { RAIL_PAGE_HIDE_NARROW } from './RailPageHeader'

/** The 42px band under the header: views on the left, Filter and Search on the right. */
export function RailPageToolbar({
  start,
  end,
  endRef,
  endProps,
  fadeOverflow = false,
  className
}: {
  start?: React.ReactNode
  end?: React.ReactNode
  /** Automations' list focus recovery falls back to the controls that produced its rows. */
  endRef?: React.Ref<HTMLDivElement>
  endProps?: React.HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>
  fadeOverflow?: boolean
  className?: string
}): React.JSX.Element {
  const viewRef = React.useRef<HTMLDivElement>(null)
  const [overflowEnd, setOverflowEnd] = React.useState(false)
  const hasViews = Boolean(start)
  const updateOverflow = React.useCallback(() => {
    const view = viewRef.current
    if (view) {
      setOverflowEnd(view.scrollWidth - view.clientWidth - view.scrollLeft > 1)
    }
  }, [])
  React.useEffect(() => {
    const view = viewRef.current
    if (!fadeOverflow || !view) {
      return
    }
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(view)
    if (view.firstElementChild) {
      observer.observe(view.firstElementChild)
    }
    return () => observer.disconnect()
  }, [fadeOverflow, hasViews, updateOverflow])

  return (
    <div
      data-rail-page-toolbar=""
      className={cn(
        'relative flex h-10.5 shrink-0 items-stretch justify-between gap-3 border-b border-border',
        RAIL_PAGE_GUTTER_X,
        className
      )}
    >
      {/* Views scroll sideways when narrow instead of wrapping into a second row. */}
      <div
        ref={viewRef}
        onScroll={fadeOverflow ? updateOverflow : undefined}
        data-rail-page-views=""
        className={cn(
          'scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto',
          fadeOverflow &&
            overflowEnd &&
            '[mask-image:linear-gradient(to_right,black_calc(100%_-_1rem),transparent)]'
        )}
      >
        {start}
      </div>
      {end ? (
        <div
          ref={endRef}
          {...endProps}
          className={cn('flex shrink-0 items-center gap-1.5', endProps?.className)}
        >
          {end}
        </div>
      ) : null}
    </div>
  )
}

export type RailPageViewItem<T extends string> = {
  value: T
  label: React.ReactNode
  /** Counts show only when every item has a true total (UX-D #5). */
  count?: number | null
  tooltip?: React.ReactNode
  disabled?: boolean
  /** Draws a divider before this item (Skills: before Shared links). */
  separatorBefore?: boolean
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>
  itemProps?: Record<`data-${string}`, string>
}

function ViewLabel({
  label,
  count,
  hideCountWhenNarrow
}: {
  label: React.ReactNode
  count?: number | null
  hideCountWhenNarrow?: boolean
}) {
  return (
    <>
      {label}
      {typeof count === 'number' ? (
        <span
          className={cn(
            'text-2xs font-normal tabular-nums text-muted-foreground',
            hideCountWhenNarrow && '@max-[40rem]/rail-page:sr-only'
          )}
        >
          {count}
        </span>
      ) : null}
    </>
  )
}

/**
 * Views of one list (radio semantics, stock ToggleGroup). Arrows move focus only; Enter/Space/click selects, so
 * arrowing never fires a provider fetch. With nothing selected the group itself is the tab stop.
 * Radix emits '' when the active item is pressed again; that is a re-press, never "no view" (D1 R3).
 */
export function RailPageViews<T extends string>({
  label,
  items,
  value,
  onValueChange,
  onReselect,
  groupProps,
  hideCountsWhenNarrow
}: {
  label: string
  items: readonly RailPageViewItem<T>[]
  value: T | null
  onValueChange: (next: T) => void
  /** A press on the already-active item. Omit for a no-op. */
  onReselect?: (current: T) => void
  groupProps?: Record<`data-${string}`, string>
  hideCountsWhenNarrow?: boolean
}): React.JSX.Element {
  const showCounts = items.length > 0 && items.every((item) => typeof item.count === 'number')
  return (
    <ToggleGroup
      type="single"
      variant="underline"
      size="sm"
      value={value ?? ''}
      aria-label={label}
      {...groupProps}
      onValueChange={(next) => {
        if (next === '') {
          if (value !== null) {
            onReselect?.(value)
          }
          return
        }
        const item = items.find(({ value: option }) => option === next)
        if (item) {
          onValueChange(item.value)
        }
      }}
    >
      {items.map((item) => {
        const node = (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            onContextMenu={item.onContextMenu}
            {...item.itemProps}
          >
            <ViewLabel
              label={item.label}
              count={showCounts ? item.count : null}
              hideCountWhenNarrow={hideCountsWhenNarrow}
            />
          </ToggleGroupItem>
        )
        const withTooltip = item.tooltip ? (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>{node}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {item.tooltip}
            </TooltipContent>
          </Tooltip>
        ) : (
          node
        )
        return item.separatorBefore ? (
          <React.Fragment key={item.value}>
            <span aria-hidden className="my-3 w-px shrink-0 bg-border" />
            {withTooltip}
          </React.Fragment>
        ) : (
          withTooltip
        )
      })}
    </ToggleGroup>
  )
}

export type RailPageNavItem = {
  key: string
  label: React.ReactNode
  count?: number | null
  current: boolean
  onSelect: () => void
  itemProps?: Record<`data-${string}`, string>
}

/** Page locations with history (Automations / Runs): buttons with aria-current, no roving (D1 B2). */
export function RailPageNav({
  label,
  items
}: {
  label: string
  items: readonly RailPageNavItem[]
}): React.JSX.Element {
  const showCounts = items.length > 0 && items.every((item) => typeof item.count === 'number')
  return (
    <nav aria-label={label} className="flex h-full shrink-0 items-stretch gap-4.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-current={item.current ? 'page' : undefined}
          onClick={item.onSelect}
          className={cn(
            toggleVariants({ variant: 'default', size: 'sm' }),
            'w-auto min-w-0 shrink-0',
            RAIL_UNDERLINE_ITEM_CLASS
          )}
          {...item.itemProps}
        >
          <ViewLabel label={item.label} count={showCounts ? item.count : null} />
        </button>
      ))}
    </nav>
  )
}

/** The toolbar's Filter trigger. Use as a Popover/DropdownMenu trigger (`asChild`). */
export const RailPageFilterButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof Button>, 'variant' | 'size' | 'children'> & {
    activeCount: number
  }
>(function RailPageFilterButton({ activeCount, ...props }, ref) {
  const t = useTranslate()
  const label = t('auto.components.github.PRFilterDropdowns.79c54552f7', 'Filters')
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="toolbar"
      aria-label={activeCount > 0 ? `${label} (${activeCount})` : label}
      data-rail-page-filter=""
      {...props}
    >
      <ListFilter className="size-3.5" />
      <span className={RAIL_PAGE_HIDE_NARROW}>{label}</span>
      {activeCount > 0 ? (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-3xs font-semibold tabular-nums text-foreground">
          {activeCount}
        </span>
      ) : null}
    </Button>
  )
})
