import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { ChevronDown, FolderOpen, ArrowRight, ExternalLink } from 'lucide-react'
import { findLinearIssueWorkspaceAttachmentInIndex } from '@/lib/linear-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { cn } from '@/lib/utils'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { LinearStateCell } from '../../task-page-linear-issue-model'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { formatRelativeTime } from '../../task-page-source-context'
import { Button } from '@/components/ui/button'
export function TaskPageLinearIssueTable({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    selectedLinearWorkspaceId,
    linearTaskSourceContext,
    selectedLinearIssueId,
    openLinearDetailPage,
    linearIssueAttachmentIndex,
    effectiveLinearDisplayProperties,
    linearIssueGridStyle,
    linearIssueListRows,
    handleOpenOrUseLinearItem
  } = model
  return (
    <div className="divide-y divide-border/50">
      {linearIssueListRows.map((row) => {
        if (row.type === 'section') {
          return (
            <div key={row.key} className="flex h-9 items-center gap-2 bg-muted/35 px-3">
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                {row.label}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{row.count}</span>
            </div>
          )
        }
        const issue = row.issue
        const selected = issue.id === selectedLinearIssueId
        const labels = issue.labels.slice(0, 3)
        const teamLabel =
          selectedLinearWorkspaceId === 'all' && issue.workspaceName
            ? `${issue.workspaceName} / ${issue.team.name}`
            : issue.team.name
        const attachedWorkspace = findLinearIssueWorkspaceAttachmentInIndex(
          linearIssueAttachmentIndex,
          issue
        )
        const attachedWorkspaceLabel = attachedWorkspace
          ? getWorktreeAttachmentLabel(attachedWorkspace)
          : null
        return (
          <div
            key={issue.id}
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            data-current={selected ? 'true' : undefined}
            onClick={() => {
              openLinearDetailPage(issue)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) {
                return
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openLinearDetailPage(issue)
              }
            }}
            className={cn(
              'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:grid-cols-[var(--linear-grid-template)]',
              selected && 'bg-accent'
            )}
            style={linearIssueGridStyle}
          >
            <div className="flex min-w-0 items-center gap-2 max-lg:!hidden">
              <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
                {issue.identifier}
              </span>
            </div>

            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                {effectiveLinearDisplayProperties.has('priority') ? (
                  <LinearPriorityIcon priority={issue.priority} />
                ) : null}
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground lg:hidden">
                  {issue.identifier}
                </span>
                <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {issue.title}
                </h3>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 lg:!hidden">
                {effectiveLinearDisplayProperties.has('state') ? (
                  <LinearStateCell
                    issue={issue}
                    className="px-1.5 py-0.5"
                    sourceContext={linearTaskSourceContext}
                  />
                ) : null}
                {effectiveLinearDisplayProperties.has('assignee') ? (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {issue.assignee?.displayName ??
                      translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
                  </span>
                ) : null}
                {effectiveLinearDisplayProperties.has('team') ? (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {teamLabel}
                  </span>
                ) : null}
                {attachedWorkspaceLabel ? (
                  <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="truncate">{attachedWorkspaceLabel}</span>
                  </span>
                ) : null}
              </div>
            </div>

            {effectiveLinearDisplayProperties.has('labels') ? (
              <div className="flex min-w-0 items-center gap-1 max-lg:!hidden">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="max-w-[150px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
                {issue.labels.length > labels.length ? (
                  <span className="text-[11px] text-muted-foreground">
                    +{issue.labels.length - labels.length}
                  </span>
                ) : null}
              </div>
            ) : null}

            {effectiveLinearDisplayProperties.has('team') ? (
              <div className="block min-w-0 text-[12px] text-muted-foreground max-lg:!hidden">
                <div className="truncate">{teamLabel}</div>
              </div>
            ) : null}

            {effectiveLinearDisplayProperties.has('state') ? (
              <div className="flex min-w-0 max-lg:!hidden">
                <LinearStateCell
                  issue={issue}
                  className="max-w-full px-2 py-0.5"
                  sourceContext={linearTaskSourceContext}
                />
              </div>
            ) : null}

            {effectiveLinearDisplayProperties.has('assignee') ? (
              <div className="flex min-w-0 justify-center max-lg:!hidden">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px] text-muted-foreground"
                      aria-label={
                        issue.assignee?.displayName ??
                        translate('auto.components.TaskPage.42a9160321', 'Unassigned')
                      }
                    >
                      {issue.assignee?.avatarUrl ? (
                        <img
                          src={issue.assignee.avatarUrl}
                          alt={issue.assignee.displayName}
                          className="size-5 rounded-full"
                        />
                      ) : (
                        (issue.assignee?.displayName?.slice(0, 1) ?? '-')
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {issue.assignee?.displayName ??
                      translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : null}

            {effectiveLinearDisplayProperties.has('updated') ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-lg:!hidden">
                    {formatRelativeTime(issue.updatedAt)}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {new Date(issue.updatedAt).toLocaleString()}
                </TooltipContent>
              </Tooltip>
            ) : null}

            <div className="flex shrink-0 items-center justify-end gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    // Why: solid primary when a workspace is already linked so Open reads stronger than Start.
                    variant={attachedWorkspace ? 'default' : 'ghost'}
                    size="icon-xs"
                    data-contextual-tour-target="tasks-start-workspace"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleOpenOrUseLinearItem(issue)
                    }}
                    className={attachedWorkspace ? 'shadow-xs' : undefined}
                    aria-label={
                      attachedWorkspace
                        ? translate(
                            'auto.components.TaskPage.linearOpenAttachedWorkspace',
                            'Open workspace attached to {{value0}}',
                            {
                              value0: issue.identifier
                            }
                          )
                        : translate(
                            'auto.components.TaskPage.ff90d0abc7',
                            'Start workspace from {{value0}}',
                            {
                              value0: issue.identifier
                            }
                          )
                    }
                  >
                    {attachedWorkspace ? (
                      <FolderOpen className="size-3.5" />
                    ) : (
                      <ArrowRight className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {attachedWorkspace
                    ? (attachedWorkspaceLabel ??
                      translate('auto.components.TaskPage.606a85c774', 'Open'))
                    : translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      window.api.shell.openUrl(issue.url)
                    }}
                    aria-label={translate(
                      'auto.components.TaskPage.246bd64aed',
                      'Open {{value0}} in Linear',
                      {
                        value0: issue.identifier
                      }
                    )}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.TaskPage.6244a02f46', 'Open in Linear')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )
}
