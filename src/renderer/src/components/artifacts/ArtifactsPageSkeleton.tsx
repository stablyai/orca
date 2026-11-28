import { cn } from '@/lib/class-names'
import { RailPageToolbar } from '@/components/rail-page/RailPageToolbar'
import { useTranslate } from '@/i18n/use-translate'
import { ARTIFACTS_TABLE_GRID_CLASS } from './artifacts-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-interaction/list-table-layout'

function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-pulse rounded bg-muted/60', className)} />
}

const TABLE_ROW_SKELETONS = [
  { id: 'row-1', name: 'w-36', type: 'w-12', size: 'w-10', updated: 'w-16', expires: 'w-20' },
  { id: 'row-2', name: 'w-28', type: 'w-16', size: 'w-12', updated: 'w-20', expires: 'w-16' },
  { id: 'row-3', name: 'w-44', type: 'w-12', size: 'w-10', updated: 'w-14', expires: 'w-24' },
  { id: 'row-4', name: 'w-32', type: 'w-14', size: 'w-11', updated: 'w-16', expires: 'w-16' },
  { id: 'row-5', name: 'w-40', type: 'w-12', size: 'w-10', updated: 'w-20', expires: 'w-20' },
  { id: 'row-6', name: 'w-24', type: 'w-16', size: 'w-12', updated: 'w-16', expires: 'w-14' }
] as const

export function ArtifactsPageSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // Why: aria-label on a roleless div is not exposed to screen readers.
      role="status"
      aria-busy="true"
      aria-label={t('auto.components.artifacts.ArtifactsPageSkeleton.loading', 'Loading artifacts')}
    >
      {/* The toolbar band's shape, so the list doesn't jump when the search arrives. */}
      <RailPageToolbar end={<SkeletonBar className="h-7 w-51 shrink-0 rounded-md" />} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn(ARTIFACTS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
          <SkeletonBar className="h-2.5 w-12" />
          <SkeletonBar className="h-2.5 w-10" />
          <SkeletonBar className="h-2.5 w-8" />
          <SkeletonBar className="h-2.5 w-14" />
          <SkeletonBar className="h-2.5 w-14" />
          <span />
        </div>
        <div className="divide-y divide-border/50">
          {TABLE_ROW_SKELETONS.map((row) => (
            <div
              key={row.id}
              className={cn(
                ARTIFACTS_TABLE_GRID_CLASS,
                'min-h-11 items-center gap-3 px-(--rail-page-gutter) py-3'
              )}
            >
              <SkeletonBar className={cn('h-3.5', row.name)} />
              <SkeletonBar className={cn('h-3.5', row.type)} />
              <SkeletonBar className={cn('h-3.5', row.size)} />
              <SkeletonBar className={cn('h-3.5', row.updated)} />
              <SkeletonBar className={cn('h-3.5', row.expires)} />
              <SkeletonBar className="size-6 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
