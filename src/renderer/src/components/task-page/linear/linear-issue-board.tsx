import React from 'react'
import { ArrowRight, ExternalLink, FolderOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import {
  findLinearIssueWorkspaceAttachmentInIndex,
  type LinearIssueWorkspaceAttachmentIndex
} from '@/lib/linear-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearDisplayProperty } from '@/components/task-page-localized-options'
import { LinearStateCell } from './linear-state-cell'
import type { LinearGroupSection } from './linear-issue-grouping'
import { formatRelativeTime } from '../relative-time'

export type LinearIssueBoardProps = {
  linearBoardSections: readonly LinearGroupSection[]
  handleLinearBoardDragOver: (
    section: LinearGroupSection,
    event: React.DragEvent<HTMLElement>
  ) => void
  handleLinearBoardDrop: (section: LinearGroupSection, event: React.DragEvent<HTMLElement>) => void
  linearBoardDragOverKey: string | null
  selectedLinearIssueId: string | null
  linearBoardDraggingIssueId: string | null
  linearBoardUpdatingIssueIds: ReadonlySet<string>
  selectedLinearWorkspaceId: LinearWorkspaceSelection | null
  linearIssueAttachmentIndex: LinearIssueWorkspaceAttachmentIndex
  linearStatusBoardEnabled: boolean
  handleLinearBoardCardDragStart: (
    issue: LinearIssue,
    event: React.DragEvent<HTMLDivElement>
  ) => void
  setLinearBoardDraggingIssueId: (id: string | null) => void
  setLinearBoardDragOverKey: (key: string | null) => void
  openLinearDetailPage: (issue: LinearIssue) => void
  effectiveLinearDisplayProperties: ReadonlySet<LinearDisplayProperty>
  handleOpenOrUseLinearItem: (issue: LinearIssue) => void
  linearTaskSourceContext: TaskSourceContext | null
}

export function LinearIssueBoard({
  linearBoardSections,
  handleLinearBoardDragOver,
  handleLinearBoardDrop,
  linearBoardDragOverKey,
  selectedLinearIssueId,
  linearBoardDraggingIssueId,
  linearBoardUpdatingIssueIds,
  selectedLinearWorkspaceId,
  linearIssueAttachmentIndex,
  linearStatusBoardEnabled,
  handleLinearBoardCardDragStart,
  setLinearBoardDraggingIssueId,
  setLinearBoardDragOverKey,
  openLinearDetailPage,
  effectiveLinearDisplayProperties,
  handleOpenOrUseLinearItem,
  linearTaskSourceContext
}: LinearIssueBoardProps): React.JSX.Element {
  return (
    <div className="grid min-w-0 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
      {linearBoardSections.map((section) => (
        <section
          key={section.key}
          onDragOver={(event) => handleLinearBoardDragOver(section, event)}
          onDrop={(event) => void handleLinearBoardDrop(section, event)}
          className={cn(
            'min-h-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
            linearBoardDragOverKey === section.key && 'border-ring/70 ring-1 ring-ring/70'
          )}
        >
          <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
            <span className="truncate text-xs font-medium text-foreground">{section.label}</span>
            <span className="text-[11px] text-muted-foreground">{section.issues.length}</span>
          </div>
          <div className="space-y-2 p-2">
            {section.issues.map((issue) => {
              const selected = issue.id === selectedLinearIssueId
              const labels = issue.labels.slice(0, 2)
              const dragging = linearBoardDraggingIssueId === issue.id
              const updating = linearBoardUpdatingIssueIds.has(issue.id)
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
                  draggable={linearStatusBoardEnabled && !updating}
                  aria-current={selected ? 'true' : undefined}
                  data-current={selected ? 'true' : undefined}
                  aria-busy={updating ? 'true' : undefined}
                  onDragStart={(event) => handleLinearBoardCardDragStart(issue, event)}
                  onDragEnd={() => {
                    setLinearBoardDraggingIssueId(null)
                    setLinearBoardDragOverKey(null)
                  }}
                  onClick={() => openLinearDetailPage(issue)}
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
                    'group/row cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    linearStatusBoardEnabled && !updating && 'cursor-grab active:cursor-grabbing',
                    selected && 'bg-accent',
                    dragging && 'opacity-50',
                    updating && 'cursor-wait opacity-70'
                  )}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                        {effectiveLinearDisplayProperties.has('priority') ? (
                          <LinearPriorityIcon priority={issue.priority} className="size-3.5" />
                        ) : null}
                        <span className="truncate">{issue.identifier}</span>
                      </div>
                      <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                        {issue.title}
                      </h3>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            // Why: solid primary when a workspace is already linked so Open reads stronger than Start.
                            variant={attachedWorkspace ? 'default' : 'ghost'}
                            size="icon-xs"
                            data-contextual-tour-target="tasks-start-workspace"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleOpenOrUseLinearItem(issue)
                            }}
                            aria-label={
                              attachedWorkspace
                                ? translate(
                                    'auto.components.TaskPage.linearOpenAttachedWorkspace',
                                    'Open workspace attached to {{value0}}',
                                    { value0: issue.identifier }
                                  )
                                : translate(
                                    'auto.components.TaskPage.ff90d0abc7',
                                    'Start workspace from {{value0}}',
                                    { value0: issue.identifier }
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
                            ? translate('auto.components.TaskPage.606a85c774', 'Open')
                            : translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          void window.api.shell.openUrl(issue.url).catch((err) => {
                            console.error('Failed to open Linear issue:', err)
                          })
                        }}
                        aria-label={translate(
                          'auto.components.TaskPage.246bd64aed',
                          'Open {{value0}} in Linear',
                          { value0: issue.identifier }
                        )}
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {effectiveLinearDisplayProperties.has('state') ? (
                      <LinearStateCell
                        issue={issue}
                        className="px-1.5 py-0.5"
                        sourceContext={linearTaskSourceContext}
                      />
                    ) : null}
                    {effectiveLinearDisplayProperties.has('assignee') ? (
                      <span>
                        {issue.assignee?.displayName ??
                          translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
                      </span>
                    ) : null}
                    {effectiveLinearDisplayProperties.has('team') ? (
                      <span className="truncate">{teamLabel}</span>
                    ) : null}
                    {effectiveLinearDisplayProperties.has('updated') ? (
                      <span>{formatRelativeTime(issue.updatedAt)}</span>
                    ) : null}
                    {attachedWorkspaceLabel ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{attachedWorkspaceLabel}</span>
                      </span>
                    ) : null}
                  </div>
                  {effectiveLinearDisplayProperties.has('labels') && issue.labels.length > 0 ? (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
                      {labels.map((label) => (
                        <span
                          key={label}
                          className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                      {issue.labels.length > labels.length ? (
                        <span className="text-[10px] text-muted-foreground">
                          +{issue.labels.length - labels.length}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
