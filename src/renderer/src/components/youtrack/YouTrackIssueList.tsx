import { ArrowRight, ExternalLink, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type { YouTrackIssue, YouTrackState } from '../../../../shared/youtrack-types'

export function YouTrackStatePill({
  state,
  className
}: {
  state: YouTrackState | null
  className?: string
}): React.JSX.Element | null {
  if (!state?.name) {
    return null
  }
  // Why both: YouTrack pairs them; a lone background under theme text is unreadable in dark mode.
  const palette =
    state.color?.background && state.color.foreground
      ? { backgroundColor: state.color.background, color: state.color.foreground }
      : undefined
  return (
    <span
      className={cn(
        'inline-flex max-w-[160px] shrink-0 items-center truncate rounded-full border border-border/50 px-2 py-0.5 text-[11px] font-medium',
        !palette && (state.isResolved ? 'text-muted-foreground' : 'text-foreground'),
        className
      )}
      // Why: YouTrack state colors are user-configured per bundle, so they can't be tokens.
      style={palette}
    >
      {state.name}
    </span>
  )
}

export function YouTrackBlockedBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
          <OctagonAlert className="size-3" />
          {count}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('youtrack.list.blockedBy', 'Blocked by {{count}} unresolved issue(s)', {
          count
        })}
      </TooltipContent>
    </Tooltip>
  )
}

function YouTrackIssueRow({
  issue,
  selected,
  onOpenIssue,
  onStartWorkspace
}: {
  issue: YouTrackIssue
  selected: boolean
  onOpenIssue: (issue: YouTrackIssue) => void
  onStartWorkspace: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenIssue(issue)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenIssue(issue)
        }
      }}
      className={cn(
        'group/row grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_150px_90px_auto]',
        selected && 'bg-accent/70'
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {issue.idReadable}
          </span>
          <span
            className={cn(
              'truncate text-[13px] font-medium text-foreground',
              issue.resolved && 'text-muted-foreground line-through'
            )}
          >
            {issue.summary}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <YouTrackStatePill state={issue.state} />
          <YouTrackBlockedBadge count={issue.unresolvedBlockerCount} />
          {issue.priority ? (
            <span className="truncate text-[11px] text-muted-foreground">{issue.priority}</span>
          ) : null}
          {issue.type ? (
            <span className="truncate text-[11px] text-muted-foreground">· {issue.type}</span>
          ) : null}
        </div>
      </div>

      <div className="hidden min-w-0 truncate text-[12px] text-muted-foreground md:block">
        {issue.assignee?.fullName ?? translate('youtrack.list.unassigned', 'Unassigned')}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="hidden min-w-0 truncate text-[12px] text-muted-foreground md:block">
            {formatUiRelativeTimeFromDate(issue.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(issue.updatedAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>

      <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                onStartWorkspace(issue)
              }}
              aria-label={translate(
                'youtrack.list.startWorkspaceFor',
                'Start workspace from {{id}}',
                {
                  id: issue.idReadable
                }
              )}
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('youtrack.list.startWorkspace', 'Start workspace')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                void window.api.shell.openUrl(issue.url)
              }}
              aria-label={translate('youtrack.list.openInYouTrackFor', 'Open {{id}} in YouTrack', {
                id: issue.idReadable
              })}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('youtrack.list.openInYouTrack', 'Open in YouTrack')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function YouTrackIssueList({
  issues,
  selectedIssueId,
  onOpenIssue,
  onStartWorkspace
}: {
  issues: YouTrackIssue[]
  selectedIssueId: string | null
  onOpenIssue: (issue: YouTrackIssue) => void
  onStartWorkspace: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {issues.map((issue) => (
        <YouTrackIssueRow
          key={issue.id}
          issue={issue}
          selected={issue.idReadable === selectedIssueId}
          onOpenIssue={onOpenIssue}
          onStartWorkspace={onStartWorkspace}
        />
      ))}
    </div>
  )
}
