import React from 'react'
import { cn } from '@/lib/class-names'
import { automationsTableGridClass } from './listing/automations-table-layout'
import {
  LIST_TABLE_CONTAINER_CLASS,
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-interaction/list-table-layout'
import { useTranslate } from '@/i18n/use-translate'

function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-pulse rounded bg-muted/60', className)} />
}

const TABLE_ROW_SKELETONS = [
  { id: 'row-1', name: 'w-28', schedule: 'w-20', project: 'w-20', next: 'w-24', last: 'w-20' },
  { id: 'row-2', name: 'w-36', schedule: 'w-28', project: 'w-24', next: 'w-20', last: 'w-24' },
  { id: 'row-3', name: 'w-24', schedule: 'w-24', project: 'w-16', next: 'w-28', last: 'w-16' },
  { id: 'row-4', name: 'w-32', schedule: 'w-20', project: 'w-24', next: 'w-24', last: 'w-20' },
  { id: 'row-5', name: 'w-40', schedule: 'w-28', project: 'w-20', next: 'w-20', last: 'w-24' }
] as const

export function AutomationsPageSkeleton(): React.JSX.Element {
  const t = useTranslate()
  const grid = automationsTableGridClass(false)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden pt-4"
      aria-busy="true"
      aria-label={t(
        'auto.components.automations.AutomationsPageSkeleton.55527b7bcf',
        'Loading automations'
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <SkeletonBar className="h-8 w-56 shrink-0 rounded-md" />
        <SkeletonBar className="h-8 w-20 shrink-0 rounded-md" />
        <SkeletonBar className="size-8 shrink-0 rounded-md" />
      </div>
      <div
        className={cn('scrollbar-sleek min-h-0 flex-1 overflow-auto', LIST_TABLE_CONTAINER_CLASS)}
        data-contextual-fix-target="automations-list"
      >
        <div className="min-w-full w-fit">
          <div className={cn(grid, LIST_TABLE_HEADER_CLASS)}>
            <span className={LIST_TABLE_STICKY_HEADER_CELL_CLASS}>
              <SkeletonBar className="h-2.5 w-12" />
            </span>
            <SkeletonBar className="h-2.5 w-14" />
            <SkeletonBar className="h-2.5 w-16" />
            <SkeletonBar className="h-2.5 w-16" />
            <span />
          </div>
          <div className="divide-y divide-border/50">
            {TABLE_ROW_SKELETONS.map((row) => (
              <div key={row.id} className={cn(grid, 'min-h-14 items-center gap-3 px-3 py-2.5')}>
                <span className={cn(LIST_TABLE_STICKY_ROW_CELL_CLASS, 'gap-2.5')}>
                  <SkeletonBar className="size-4 shrink-0 rounded" />
                  <span className="flex flex-col gap-1.5">
                    <SkeletonBar className={cn('h-3.5', row.name)} />
                    <SkeletonBar className={cn('h-3', row.schedule)} />
                  </span>
                </span>
                <SkeletonBar className={cn('h-3.5', row.project)} />
                <SkeletonBar className={cn('h-3.5', row.next)} />
                <SkeletonBar className={cn('h-3.5', row.last)} />
                <SkeletonBar className="size-6 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
