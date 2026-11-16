import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Button } from '../../ui/button'

// Why CSS, not a JS card count: the column count comes from container queries, so the hidden cards
// track the grid's own breakpoints below (1 column, then 2 from 460px, 3 from 720px, 4 from 1056px).
const GRID_ONE_ROW = [
  '[&>li:nth-child(n+5)]:hidden',
  '@max-[1056px]/plugin-catalog:[&>li:nth-child(n+4)]:hidden',
  '@max-[720px]/plugin-catalog:[&>li:nth-child(n+3)]:hidden',
  '@max-[460px]/plugin-catalog:[&>li:nth-child(n+2)]:hidden'
]

// Per column count c: hide cards past two rows (n+2c+1), and a partial last row after the first.
// `nth-child(cn+c+1):nth-last-child(-n+c-1)` is the first card of a partial row past row one; it
// and the cards after it (`~li`) hide.
const GRID_TWO_FULL_ROWS = [
  '@max-[460px]/plugin-catalog:[&>li:nth-child(n+3)]:hidden',
  '@min-[460px]/plugin-catalog:@max-[720px]/plugin-catalog:[&>li:nth-child(n+5)]:hidden',
  '@min-[460px]/plugin-catalog:@max-[720px]/plugin-catalog:[&>li:nth-child(2n+3):last-child]:hidden',
  '@min-[720px]/plugin-catalog:@max-[1056px]/plugin-catalog:[&>li:nth-child(n+7)]:hidden',
  '@min-[720px]/plugin-catalog:@max-[1056px]/plugin-catalog:[&>li:nth-child(3n+4):nth-last-child(-n+2)]:hidden',
  '@min-[720px]/plugin-catalog:@max-[1056px]/plugin-catalog:[&>li:nth-child(3n+4):nth-last-child(-n+2)~li]:hidden',
  '@min-[1056px]/plugin-catalog:[&>li:nth-child(n+9)]:hidden',
  '@min-[1056px]/plugin-catalog:[&>li:nth-child(4n+5):nth-last-child(-n+3)]:hidden',
  '@min-[1056px]/plugin-catalog:[&>li:nth-child(4n+5):nth-last-child(-n+3)~li]:hidden'
]

type PluginListGroupProps = {
  title: string
  /** Trust and origin after the title, e.g. "verified · stablyai". */
  detail?: string
  /** Right-aligned summary, e.g. "6 of 48". */
  aside?: React.ReactNode
  /** Notice between the heading and the rows (a stale-catalog warning, a load error). */
  notice?: React.ReactNode
  hiddenCount?: number
  /** Every row the group holds, shown and hidden, for the Show all label. */
  totalCount?: number
  onShowAll?: () => void
  showHeading?: boolean
  /** `grid` lays its children out as catalog cards. */
  layout?: 'list' | 'grid'
  /**
   * Grid only: show at most this many rows at the current column count. Two rows show only full
   * rows, so no card sits alone on the last one; a lone partial first row still shows.
   */
  maxRows?: 1 | 2
  children?: React.ReactNode
}

/** A titled run of plugin rows: Installed, or one catalog. */
export function PluginListGroup({
  title,
  detail,
  aside,
  notice,
  hiddenCount = 0,
  totalCount = 0,
  onShowAll,
  showHeading = true,
  layout = 'list',
  maxRows,
  children
}: PluginListGroupProps): React.JSX.Element {
  const t = useTranslate()
  const headingId = useId()
  return (
    <section
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
    >
      {showHeading ? (
        <div
          data-layout={layout}
          className="flex items-baseline gap-2 px-4 pt-3.5 pb-1.5 data-[layout=grid]:px-0.5 data-[layout=grid]:pt-0 data-[layout=grid]:pb-2.5"
        >
          <h3
            id={headingId}
            className="text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase"
          >
            {title}
          </h3>
          {detail ? (
            <span className="truncate text-xs text-muted-foreground">· {detail}</span>
          ) : null}
          {aside ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{aside}</span>
          ) : null}
        </div>
      ) : null}
      {notice}
      {/* Why 1056px for four columns: cards stay as wide as three were at the old page width. */}
      {children ? (
        <ul
          data-layout={layout}
          className={cn(
            'list-none data-[layout=grid]:grid data-[layout=grid]:grid-cols-1 data-[layout=grid]:gap-4 data-[layout=grid]:@min-[460px]/plugin-catalog:grid-cols-2 data-[layout=grid]:@min-[720px]/plugin-catalog:grid-cols-3 data-[layout=grid]:@min-[1056px]/plugin-catalog:grid-cols-4',
            maxRows === 1 && GRID_ONE_ROW,
            maxRows === 2 && GRID_TWO_FULL_ROWS
          )}
        >
          {children}
        </ul>
      ) : null}
      {hiddenCount > 0 && onShowAll ? (
        layout === 'grid' ? (
          // Why full width: a small trailing link under a card grid read as the end of the list.
          <Button variant="outline" size="sm" className="mt-4 w-full" onClick={onShowAll}>
            <ChevronDown />
            {t(
              'auto.components.pluginCatalog.PluginListGroup.showAllTotal',
              'Show all {{value0}} plugins',
              { value0: totalCount }
            )}
          </Button>
        ) : (
          <div className="border-t border-border px-2 py-1.5">
            <Button variant="ghost" size="xs" onClick={onShowAll}>
              <ChevronDown />
              {t('auto.components.pluginCatalog.PluginListGroup.showAll', 'Show {{value0}} more', {
                value0: hiddenCount
              })}
            </Button>
          </div>
        )
      ) : null}
    </section>
  )
}
