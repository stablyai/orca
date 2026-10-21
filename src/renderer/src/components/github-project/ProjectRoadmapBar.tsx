import React from 'react'
import { GitPullRequest, Lock } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { chipStyle, labelChipColors, singleSelectChipColors } from './project-cell-chip-colors'
import { formatRoadmapSpan } from './roadmap-tick-format'
import type { RoadmapSpan } from '../../../../shared/github/project-roadmap-timeline'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'

const MIN_BAR_WIDTH_PX = 24

type Props = {
  row: GitHubProjectRow
  span: RoadmapSpan
  leftPx: number
  widthPx: number
  /** GitHub single-select color token for the row's status, when it has one. */
  chipColor: string | null
  locale: string
  onOpen?: () => void
}

export default function ProjectRoadmapBar({
  row,
  span,
  leftPx,
  widthPx,
  chipColor,
  locale,
  onOpen
}: Props): React.JSX.Element {
  const colors = chipColor ? singleSelectChipColors(chipColor) : labelChipColors('')
  const interactive = row.itemType !== 'REDACTED' && row.itemType !== 'DRAFT_ISSUE'
  const dates = formatRoadmapSpan(span, locale)
  // Why: shared by the visible text, aria-label, and tooltip — a redacted row
  // must never announce or render an empty name.
  const title =
    row.itemType === 'REDACTED'
      ? translate('auto.components.github.project.ProjectRoadmapBar.7d1220d979', 'Restricted item')
      : row.content.title
  const bar = (
    <button
      type="button"
      aria-disabled={interactive ? undefined : true}
      onClick={interactive ? onOpen : undefined}
      aria-label={translate(
        'auto.components.github.project.ProjectRoadmapBar.cd68ccc17a',
        '{{value0}} — {{value1}}',
        { value0: title, value1: dates }
      )}
      className={cn(
        'absolute top-1/2 flex h-6 -translate-y-1/2 items-center gap-1.5 overflow-hidden rounded-md px-2 text-[11px] font-medium leading-none',
        'text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]',
        interactive ? 'cursor-pointer hover:brightness-110' : 'cursor-default',
        row.itemType === 'REDACTED' && 'opacity-60',
        // Why: a point marker sizes to its own label instead of the span, so
        // a single-date item stays readable rather than collapsing to a sliver.
        span.point && 'max-w-60'
      )}
      style={{
        left: span.point ? Math.max(0, leftPx - 6) : leftPx,
        ...(span.point ? {} : { width: Math.max(widthPx, MIN_BAR_WIDTH_PX) }),
        ...chipStyle(colors)
      }}
    >
      {span.point ? (
        <span aria-hidden className="size-2 shrink-0 rotate-45 rounded-[1px] bg-current" />
      ) : null}
      {row.itemType === 'PULL_REQUEST' ? (
        <GitPullRequest className="size-3 shrink-0" />
      ) : row.itemType === 'REDACTED' ? (
        <Lock className="size-3 shrink-0" />
      ) : null}
      {row.content.number == null ? null : (
        <span className="shrink-0 opacity-70">#{row.content.number}</span>
      )}
      <span className="truncate">{title}</span>
    </button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{bar}</TooltipTrigger>
      <TooltipContent side="top" align="start">
        <div className="max-w-72 space-y-0.5">
          <div className="truncate font-medium">{title}</div>
          <div className="text-muted-foreground">{dates}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
