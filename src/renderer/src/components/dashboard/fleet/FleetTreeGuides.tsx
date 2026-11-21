import { cn } from '@/lib/class-names'
import type { FleetTreeRow } from './fleet-tree-rows'

export const FLEET_GUIDE_LINE_CLASS = 'border-muted-foreground/30'

export function FleetTreeGuides({ row }: { row: FleetTreeRow }): React.JSX.Element | null {
  if (row.depth === 0) {
    return null
  }
  return (
    <span aria-hidden className="flex shrink-0 self-stretch">
      {row.continuingAncestors.map((continues, index) => (
        <span key={index} className="relative w-5 shrink-0">
          {continues ? (
            <span className={cn('absolute inset-y-0 left-2.5 border-l', FLEET_GUIDE_LINE_CLASS)} />
          ) : null}
        </span>
      ))}
      <span className="relative w-5 shrink-0">
        <span
          className={cn(
            'absolute top-0 right-0 left-2.5 h-5 rounded-bl-md border-b border-l',
            FLEET_GUIDE_LINE_CLASS
          )}
        />
        {row.isLastSibling ? null : (
          <span className={cn('absolute inset-y-0 left-2.5 border-l', FLEET_GUIDE_LINE_CLASS)} />
        )}
      </span>
    </span>
  )
}
