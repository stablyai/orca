import { ArrowRight, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type {
  JiraIssue,
  JiraIssueUpdate,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'

function jiraStatusClass(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (categoryKey === 'indeterminate') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

export function JiraIssueWorkspaceHeader({
  displayed,
  issueLoading,
  onUse,
  onClose
}: {
  displayed: JiraIssue
  issueLoading: boolean
  onUse: (issue: JiraIssue) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{displayed.key}</span>
            {displayed.siteName ? <span>{displayed.siteName}</span> : null}
            <span>{displayed.project.key}</span>
            <span>{formatUiRelativeTimeFromDate(displayed.updatedAt)}</span>
            {issueLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
          </div>
          <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
            {displayed.title}
          </h2>
        </div>
        <Button
          onClick={() => onUse(displayed)}
          className="hidden shrink-0 gap-2 sm:inline-flex"
          size="sm"
        >
          {translate('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
          <ArrowRight className="size-4" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onClose}
              aria-label={translate(
                'auto.components.JiraIssueWorkspace.76513c7898',
                'Close Jira issue preview'
              )}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.JiraIssueWorkspace.7a96985ca0', 'Close')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function JiraIssueMetadataBar({
  displayed,
  pendingField,
  transitions,
  priorities,
  users,
  mutateIssue
}: {
  displayed: JiraIssue
  pendingField: string | null
  transitions: JiraTransition[]
  priorities: JiraPriority[]
  users: JiraUser[]
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={pendingField === 'transition' || transitions.length === 0}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80 disabled:opacity-50',
              jiraStatusClass(displayed.status.categoryKey)
            )}
          >
            {displayed.status.name}
            {pendingField === 'transition' ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {transitions.map((transition) => (
            <button
              key={transition.id}
              type="button"
              onClick={() =>
                void mutateIssue(
                  'transition',
                  { transitionId: transition.id },
                  { status: transition.to }
                )
              }
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              {transition.name}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={pendingField === 'priority'}
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
          >
            {displayed.priority?.name ??
              translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
            {pendingField === 'priority' ? (
              <LoaderCircle className="ml-1 inline size-3 animate-spin" />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-48 p-1" align="start">
          <button
            type="button"
            onClick={() =>
              void mutateIssue('priority', { priorityId: null }, { priority: undefined })
            }
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
          >
            {translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
          </button>
          {priorities.map((priority) => (
            <button
              key={priority.id}
              type="button"
              onClick={() =>
                void mutateIssue('priority', { priorityId: priority.id }, { priority })
              }
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              {priority.name}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={pendingField === 'assignee'}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
          >
            {displayed.assignee?.displayName ??
              translate('auto.components.JiraIssueWorkspace.54649eaeab', '+ Assignee')}
            {pendingField === 'assignee' ? <LoaderCircle className="size-3 animate-spin" /> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-56 p-1" align="start">
          <button
            type="button"
            onClick={() =>
              void mutateIssue('assignee', { assigneeAccountId: null }, { assignee: undefined })
            }
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
          >
            {translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
          </button>
          {users.map((user) => (
            <button
              key={user.accountId}
              type="button"
              onClick={() =>
                void mutateIssue(
                  'assignee',
                  { assigneeAccountId: user.accountId },
                  { assignee: user }
                )
              }
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
              ) : null}
              <span className="truncate">{user.displayName}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
