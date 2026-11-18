import { cn } from '@/lib/class-names'
import type { FleetTreeRow } from './fleet-tree-rows'

export const FLEET_GUIDE_LINE_CLASS = 'border-muted-foreground/30'

const GEOMETRY = {
  row: { cell: 'w-4', line: 'left-1', elbow: 'h-1/2' },
  card: { cell: 'w-5', line: 'left-2.5', elbow: 'h-5' }
} as const

export type FleetTreeGuideGeometry = keyof typeof GEOMETRY

export function FleetTreeGuides({
  row,
  geometry
}: {
  row: FleetTreeRow
  geometry: FleetTreeGuideGeometry
}): React.JSX.Element | null {
  if (row.depth === 0) {
    return null
  }
  const { cell, line, elbow } = GEOMETRY[geometry]
  return (
    <span aria-hidden className="flex shrink-0 self-stretch">
      {row.continuingAncestors.map((continues, index) => (
        <span key={index} className={cn('relative shrink-0', cell)}>
          {continues ? (
            <span className={cn('absolute inset-y-0 border-l', line, FLEET_GUIDE_LINE_CLASS)} />
          ) : null}
        </span>
      ))}
      <span className={cn('relative shrink-0', cell)}>
        <span
          className={cn(
            'absolute top-0 right-0 rounded-bl-md border-b border-l',
            line,
            elbow,
            FLEET_GUIDE_LINE_CLASS
          )}
        />
        {row.isLastSibling ? null : (
          <span className={cn('absolute inset-y-0 border-l', line, FLEET_GUIDE_LINE_CLASS)} />
        )}
      </span>
    </span>
  )
}
