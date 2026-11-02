import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'

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
  children
}: PluginListGroupProps): React.JSX.Element {
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
          className="list-none data-[layout=grid]:grid data-[layout=grid]:grid-cols-1 data-[layout=grid]:gap-4 data-[layout=grid]:@min-[460px]/plugin-catalog:grid-cols-2 data-[layout=grid]:@min-[720px]/plugin-catalog:grid-cols-3 data-[layout=grid]:@min-[1056px]/plugin-catalog:grid-cols-4"
        >
          {children}
        </ul>
      ) : null}
      {hiddenCount > 0 && onShowAll ? (
        layout === 'grid' ? (
          // Why full width: a small trailing link under a card grid read as the end of the list.
          <Button variant="outline" size="sm" className="mt-4 w-full" onClick={onShowAll}>
            <ChevronDown />
            {translate(
              'auto.components.pluginCatalog.PluginListGroup.showAllTotal',
              'Show all {{value0}} plugins',
              { value0: totalCount }
            )}
          </Button>
        ) : (
          <div className="border-t border-border px-2 py-1.5">
            <Button variant="ghost" size="xs" onClick={onShowAll}>
              <ChevronDown />
              {translate(
                'auto.components.pluginCatalog.PluginListGroup.showAll',
                'Show {{value0}} more',
                {
                  value0: hiddenCount
                }
              )}
            </Button>
          </div>
        )
      ) : null}
    </section>
  )
}
