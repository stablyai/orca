import React from 'react'
import { cn } from '@/lib/utils'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import {
  LIST_TABLE_CONTAINER_CLASS,
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-table-layout'
import { translate } from '@/i18n/i18n'

function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-pulse rounded bg-muted/60', className)} />
}

function TableRowSkeleton({
  nameWidthClass,
  scheduleWidthClass,
  projectWidthClass,
  hostWidthClass,
  nextWidthClass,
  lastRunWidthClass,
  statusWidthClass
}: {
  nameWidthClass: string
  scheduleWidthClass: string
  projectWidthClass: string
  hostWidthClass: string
  nextWidthClass: string
  lastRunWidthClass: string
  statusWidthClass: string
}): React.JSX.Element {
  return (
    <div className={cn(AUTOMATIONS_TABLE_GRID_CLASS, 'min-h-11 items-center gap-3 px-3 py-3')}>
      <span className={LIST_TABLE_STICKY_ROW_CELL_CLASS}>
        <SkeletonBar className={cn('h-3.5', nameWidthClass)} />
      </span>
      <SkeletonBar className={cn('h-3.5', scheduleWidthClass)} />
      <SkeletonBar className={cn('h-3.5', projectWidthClass)} />
      <SkeletonBar className={cn('h-3.5', hostWidthClass)} />
      <SkeletonBar className={cn('h-3.5', nextWidthClass)} />
      <SkeletonBar className={cn('h-3.5', lastRunWidthClass)} />
      <SkeletonBar className={cn('h-3.5', statusWidthClass)} />
      <SkeletonBar className="mx-auto size-4 rounded" />
      <SkeletonBar className="size-6 rounded-md" />
    </div>
  )
}

const TABLE_ROW_SKELETONS = [
  {
    id: 'row-1',
    nameWidthClass: 'w-28',
    scheduleWidthClass: 'w-36',
    projectWidthClass: 'w-28',
    hostWidthClass: 'w-20',
    nextWidthClass: 'w-24',
    lastRunWidthClass: 'w-20',
    statusWidthClass: 'w-16'
  },
  {
    id: 'row-2',
    nameWidthClass: 'w-36',
    scheduleWidthClass: 'w-28',
    projectWidthClass: 'w-32',
    hostWidthClass: 'w-24',
    nextWidthClass: 'w-20',
    lastRunWidthClass: 'w-24',
    statusWidthClass: 'w-14'
  },
  {
    id: 'row-3',
    nameWidthClass: 'w-24',
    scheduleWidthClass: 'w-40',
    projectWidthClass: 'w-24',
    hostWidthClass: 'w-16',
    nextWidthClass: 'w-28',
    lastRunWidthClass: 'w-16',
    statusWidthClass: 'w-16'
  },
  {
    id: 'row-4',
    nameWidthClass: 'w-32',
    scheduleWidthClass: 'w-32',
    projectWidthClass: 'w-36',
    hostWidthClass: 'w-20',
    nextWidthClass: 'w-24',
    lastRunWidthClass: 'w-20',
    statusWidthClass: 'w-14'
  },
  {
    id: 'row-5',
    nameWidthClass: 'w-40',
    scheduleWidthClass: 'w-24',
    projectWidthClass: 'w-28',
    hostWidthClass: 'w-24',
    nextWidthClass: 'w-20',
    lastRunWidthClass: 'w-24',
    statusWidthClass: 'w-16'
  },
  {
    id: 'row-6',
    nameWidthClass: 'w-28',
    scheduleWidthClass: 'w-36',
    projectWidthClass: 'w-20',
    hostWidthClass: 'w-20',
    nextWidthClass: 'w-24',
    lastRunWidthClass: 'w-16',
    statusWidthClass: 'w-14'
  }
] as const

export function AutomationsPageSkeleton(): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-3 pb-4 md:px-5"
      aria-busy="true"
      aria-label={translate(
        'auto.components.automations.AutomationsPageSkeleton.55527b7bcf',
        'Loading automations'
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SkeletonBar className="h-8 w-56 shrink-0 rounded-md" />
          <SkeletonBar className="h-8 w-20 shrink-0 rounded-md" />
          <SkeletonBar className="size-8 shrink-0 rounded-md" />
        </div>
        <SkeletonBar className="h-8 w-32 shrink-0 rounded-md" />
      </div>
      <div
        className={cn('scrollbar-sleek min-h-0 flex-1 overflow-auto', LIST_TABLE_CONTAINER_CLASS)}
        data-contextual-fix-target="automations-list"
      >
        <div className="min-w-full w-fit">
          <div className={cn(AUTOMATIONS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
            <span className={LIST_TABLE_STICKY_HEADER_CELL_CLASS}>
              <SkeletonBar className="h-2.5 w-12" />
            </span>
            <SkeletonBar className="h-2.5 w-14" />
            <SkeletonBar className="h-2.5 w-14" />
            <SkeletonBar className="h-2.5 w-12" />
            <SkeletonBar className="h-2.5 w-16" />
            <SkeletonBar className="h-2.5 w-16" />
            <SkeletonBar className="h-2.5 w-12" />
            <SkeletonBar className="mx-auto h-2.5 w-10" />
            <span />
          </div>
          <div className="divide-y divide-border/50">
            {TABLE_ROW_SKELETONS.map(({ id, ...row }) => (
              <TableRowSkeleton key={id} {...row} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
