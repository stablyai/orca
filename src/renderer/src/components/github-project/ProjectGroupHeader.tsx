import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isIterationCurrent, type ProjectGroup } from './group-sort'

type Props = {
  group: ProjectGroup
  expanded: boolean
  onToggle: () => void
}

export default function ProjectGroupHeader({
  group,
  expanded,
  onToggle
}: Props): React.JSX.Element {
  const isCurrent = group.iteration ? isIterationCurrent(group.iteration) : false
  const dateRange = group.iteration
    ? formatDateRange(group.iteration.startDate, group.iteration.duration)
    : null
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-left text-xs',
        'hover:bg-muted/60'
      )}
    >
      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      <span className="font-medium">{group.label || 'All'}</span>
      <span className="rounded-full border border-border/50 bg-background px-1.5 text-[10px] text-muted-foreground">
        {group.rows.length}
      </span>
      {dateRange ? <span className="text-[10px] text-muted-foreground">{dateRange}</span> : null}
      {isCurrent ? (
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300">
          Current
        </span>
      ) : null}
    </button>
  )
}

function formatDateRange(startDate: string, duration: number): string {
  const start = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime())) {
    return ''
  }
  const end = new Date(start.getTime() + (duration - 1) * 86_400_000)
  const fmt = (d: Date): string => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  return `${fmt(start)} – ${fmt(end)}`
}
