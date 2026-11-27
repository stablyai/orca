import { ArrowRight, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { getJiraStatusTone } from '@/components/task-page/jira/listing/task-page-jira-status-tone'
import type {
  ItsaplanIssue,
  ItsaplanStateType
} from '../../../../../../shared/itsaplan/itsaplan-types'
import { formatRelativeTime } from '../../task-page-source-context'

export function getItsaplanStateTone(stateType: ItsaplanStateType): string {
  return getJiraStatusTone(
    stateType === 'completed' ? 'done' : stateType === 'started' ? 'indeterminate' : 'new'
  )
}

export function ItsaplanStatePill({
  state,
  className
}: {
  state: ItsaplanIssue['state']
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-[11px]',
        getItsaplanStateTone(state.stateType),
        className
      )}
    >
      {state.name}
    </span>
  )
}

export function ItsaplanIssueRow({
  issue,
  onOpen,
  onStart
}: {
  issue: ItsaplanIssue
  onOpen: (issue: ItsaplanIssue) => void
  onStart: (issue: ItsaplanIssue) => void
}): React.JSX.Element {
  const t = useTranslate()
  const labels = issue.labels.slice(0, 2)
  const assigneeName =
    issue.assignee?.name ?? t('auto.components.TaskPage.42a9160321', 'Unassigned')
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issue)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(issue)
        }
      }}
      className="group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:grid-cols-[96px_minmax(0,1fr)_minmax(0,180px)_140px_120px_72px_auto]"
    >
      <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground max-lg:!hidden">
        {issue.identifier}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground lg:hidden">
            {issue.identifier}
          </span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {issue.title}
          </h3>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 lg:!hidden">
          <ItsaplanStatePill state={issue.state} className="px-1.5" />
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{assigneeName}</span>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1 max-lg:!hidden">
        {labels.map((label) => (
          <span
            key={label.id}
            className="max-w-[120px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {label.name}
          </span>
        ))}
        {issue.labels.length > labels.length ? (
          <span className="text-[11px] text-muted-foreground">
            +{issue.labels.length - labels.length}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 max-lg:!hidden">
        <ItsaplanStatePill state={issue.state} />
      </div>
      <span className="min-w-0 truncate text-[12px] text-muted-foreground max-lg:!hidden">
        {assigneeName}
      </span>
      <span className="min-w-0 truncate text-[12px] text-muted-foreground max-lg:!hidden">
        {formatRelativeTime(issue.updatedAt)}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                onStart(issue)
              }}
              aria-label={t(
                'auto.components.TaskPage.ff90d0abc7',
                'Start workspace from {{value0}}',
                {
                  value0: issue.identifier
                }
              )}
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('auto.components.TaskPage.7d08e8be0f', 'Start')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                openAppHttpLink(issue.url, { event })
              }}
              aria-label={t('taskProviders.itsaplan.openInBrowser', 'Open in browser')}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('taskProviders.itsaplan.openInBrowser', 'Open in browser')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
