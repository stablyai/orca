import React from 'react'
import { cn } from '@/lib/utils'

/** Matches the placeholder treatment used by the other page skeletons. */
export function SkeletonBar({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-pulse rounded bg-muted/60', className)} />
}

// Why: mirror the real metric column widths so rows land where the skeleton sat.
const CPU_COLUMN_CLS = 'w-12'
const MEM_COLUMN_CLS = 'w-16'
const TRAILING_GUTTER_CLS = 'w-5'

function MetricBars(): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center">
      <div className={cn(CPU_COLUMN_CLS, 'flex justify-end')}>
        <SkeletonBar className="h-3 w-7" />
      </div>
      <div className={cn(MEM_COLUMN_CLS, 'flex justify-end')}>
        <SkeletonBar className="h-3 w-11" />
      </div>
      <span className={TRAILING_GUTTER_CLS} aria-hidden />
    </div>
  )
}

function WorktreeRowSkeleton({ nameWidth }: { nameWidth: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-2 pl-4 pr-3">
      <SkeletonBar className={cn('h-3.5', nameWidth)} />
      <span className="flex-1" />
      <MetricBars />
    </div>
  )
}

function SessionRowSkeleton({ nameWidth }: { nameWidth: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-10 pr-3">
      <SkeletonBar className="size-1.5 rounded-full" />
      <SkeletonBar className={cn('h-3', nameWidth)} />
      <span className="flex-1" />
      <MetricBars />
    </div>
  )
}

const GROUPS = [
  { name: 'w-24', sessions: ['w-16', 'w-20'] },
  { name: 'w-20', sessions: ['w-20'] }
]

/** Shown only once a host's first snapshot is genuinely slow. */
export function ResourceManagerSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden>
      {GROUPS.map((group) => (
        <div key={group.name} className="border-b border-border/20 last:border-b-0">
          <WorktreeRowSkeleton nameWidth={group.name} />
          {group.sessions.map((sessionWidth) => (
            <SessionRowSkeleton key={sessionWidth} nameWidth={sessionWidth} />
          ))}
        </div>
      ))}
    </div>
  )
}
