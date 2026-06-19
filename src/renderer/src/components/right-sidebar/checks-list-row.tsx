import React from 'react'
import { ChevronRight, CircleDashed, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openHttpLink } from '@/lib/http-link-routing'
import { translate } from '@/i18n/i18n'
import { CHECK_COLOR, CHECK_ICON } from './checks-panel-status-style'
import { CheckRunDetails, type CheckDetailsStickySurface } from './checks-list-details'
import { getCheckStatusLabel, type CheckDetailsLoadState } from './checks-list-model'
import type { PRCheckDetail } from '../../../../shared/types'

export type ChecksListRowModel = {
  check: PRCheckDetail
  key: string
}

export function ChecksListRow({
  row,
  expanded,
  detailsState,
  checkDetailsContextKey,
  resolvedWorktreeId,
  detailsStickySurface,
  onToggle
}: {
  row: ChecksListRowModel
  expanded: boolean
  detailsState: CheckDetailsLoadState | undefined
  checkDetailsContextKey: string
  resolvedWorktreeId: string | null
  detailsStickySurface: CheckDetailsStickySurface
  onToggle: (row: ChecksListRowModel) => void
}): React.JSX.Element {
  const check = row.check
  const conclusion = check.conclusion ?? 'pending'
  const Icon = CHECK_ICON[conclusion] ?? CircleDashed
  const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
  const openUrl = check.url
  const toggleDetailsLabel = translate(
    'auto.components.right.sidebar.checks.panel.content.1f7d1f8a55',
    'Toggle check details for {{value0}}',
    { value0: check.name }
  )
  return (
    <div className="min-w-0">
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'group/check-row flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          expanded && 'bg-accent/25'
        )}
        onClick={() => onToggle(row)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return
          }
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }
          event.preventDefault()
          onToggle(row)
        }}
        aria-expanded={expanded}
        aria-label={toggleDetailsLabel}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <Icon
          className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
        />
        <span className="flex-1 truncate text-[12px] text-foreground">{check.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{getCheckStatusLabel(check)}</span>
          {openUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                  aria-label={translate(
                    'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                    'Open check details'
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    openHttpLink(openUrl)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <ExternalLink className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={4}>
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                  'Open check details'
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
      {expanded && (
        <CheckRunDetails
          check={check}
          state={detailsState}
          checkDetailsContextKey={checkDetailsContextKey}
          worktreeId={resolvedWorktreeId}
          detailsStickySurface={detailsStickySurface}
        />
      )}
    </div>
  )
}
