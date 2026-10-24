import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

type PluginListGroupProps = {
  title: string
  /** Trust and origin after the title, e.g. "verified · stablyai". */
  detail?: string
  /** Right-aligned summary, e.g. "6 of 48". */
  aside?: React.ReactNode
  /** Notice between the heading and the rows (a stale-catalog warning, a load error). */
  notice?: React.ReactNode
  hiddenCount?: number
  onShowAll?: () => void
  showHeading?: boolean
  children?: React.ReactNode
}

/** A titled run of plugin rows: Installed, or one catalog. */
export function PluginListGroup({
  title,
  detail,
  aside,
  notice,
  hiddenCount = 0,
  onShowAll,
  showHeading = true,
  children
}: PluginListGroupProps): React.JSX.Element {
  const headingId = useId()
  return (
    <section
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
    >
      {showHeading ? (
        <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-1.5">
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
      {children ? <ul className="list-none">{children}</ul> : null}
      {hiddenCount > 0 && onShowAll ? (
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
      ) : null}
    </section>
  )
}
