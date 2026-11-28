import React, { useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isSidebarLabelTruncated } from '@/components/ui/truncated-sidebar-label'
import {
  EMPTY_PROJECT_GROUP_KEY,
  isIterationCurrent,
  type ProjectGroup
} from '../../../../shared/github/projects/project-group-sort'
import { useTranslate } from '@/i18n/use-translate'

// Why: the label track's 0 minimum keeps a long label from widening the table, while the
// fixed parts still set the table's minimum width so rows cover them in a narrow pane.
const TABLE_BAND_ROW_CLASS =
  'grid min-w-0 grid-flow-col grid-cols-[auto_minmax(0,max-content)] auto-cols-max whitespace-nowrap'

type Props = {
  group: ProjectGroup
  /** Names the empty bucket; shared grouping words it in English for other clients. */
  groupFieldName: string
  expanded: boolean
  onToggle: () => void
  /** Set the roadmap band width while pinning its label within the visible viewport. */
  bandWidth?: number
}

export default function ProjectGroupHeader({
  group,
  groupFieldName,
  expanded,
  onToggle,
  bandWidth
}: Props): React.JSX.Element {
  const t = useTranslate()
  const isCurrent = group.iteration ? isIterationCurrent(group.iteration) : false
  const dateRange = group.iteration
    ? formatDateRange(group.iteration.startDate, group.iteration.duration)
    : null
  const inTable = bandWidth == null
  const labelRef = useRef<HTMLSpanElement>(null)
  const [labelTooltipOpen, setLabelTooltipOpen] = useState(false)
  const label =
    group.key === EMPTY_PROJECT_GROUP_KEY
      ? t('projectBoard.noField', 'No {{field}}', { field: groupFieldName })
      : group.label || t('auto.components.github.project.ProjectGroupHeader.244c9e7d06', 'All')
  const band = (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center border-b border-border/50 bg-muted/40 px-3 py-1.5 text-left text-xs',
        'hover:bg-muted/60',
        // Keep the band painted to the pane’s edge when the timeline is narrower.
        bandWidth == null ? 'w-full' : 'min-w-full'
      )}
      style={bandWidth == null ? undefined : { width: bandWidth }}
    >
      <span
        className={cn('items-center gap-2', inTable ? TABLE_BAND_ROW_CLASS : 'flex sticky left-3')}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span ref={labelRef} className={cn('font-medium', inTable && 'truncate')}>
          {label}
        </span>
        <span className="rounded-full border border-border/50 bg-background px-1.5 text-[10px] text-muted-foreground">
          {group.rows.length}
        </span>
        {dateRange ? <span className="text-[10px] text-muted-foreground">{dateRange}</span> : null}
        {isCurrent ? (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300">
            {t('auto.components.github.project.ProjectGroupHeader.82a22d2079', 'Current')}
          </span>
        ) : null}
      </span>
    </button>
  )
  if (!inTable) {
    return band
  }
  // Show the full label on hover or keyboard focus, only when the table truncated it.
  return (
    <Tooltip
      open={labelTooltipOpen}
      onOpenChange={(open) =>
        setLabelTooltipOpen(open && !!labelRef.current && isSidebarLabelTruncated(labelRef.current))
      }
    >
      <TooltipTrigger asChild>{band}</TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-80 whitespace-normal break-all text-left"
      >
        {label}
      </TooltipContent>
    </Tooltip>
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
