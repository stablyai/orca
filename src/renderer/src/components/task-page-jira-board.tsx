import React, { useMemo, useState } from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  readJiraBoardIssueDragData,
  writeJiraBoardIssueDragData
} from '@/lib/jira-board-drag-payload'
import type { JiraBoardIssueDragRef } from '@/lib/jira-board-drag-payload'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/types'
import {
  buildJiraBoardSections,
  type TaskPageJiraBoardSection
} from './task-page-jira-board-sections'

export function jiraBoardIssueRefKey(issue: Pick<JiraIssue, 'key' | 'siteId'>): string {
  return `${issue.siteId ?? 'site'}:${issue.key}`
}

function matchesDragRef(issue: JiraIssue, ref: JiraBoardIssueDragRef): boolean {
  if (issue.key !== ref.key) {
    return false
  }
  return !ref.siteId || !issue.siteId || ref.siteId === issue.siteId
}

type TaskPageJiraBoardProps = {
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
  issues: JiraIssue[]
  onMoveIssue: (issue: JiraIssue, section: TaskPageJiraBoardSection) => Promise<void>
  onOpenIssue: (issue: JiraIssue) => void
  onStartWorkspace: (issue: JiraIssue) => void
  selectedIssue: JiraIssue | null
  showSiteContext: boolean
  statusDirection?: 'asc' | 'desc'
  statusOrder: JiraProjectStatusOrder | null
  updatingIssueKeys: ReadonlySet<string>
}

function isSelectedIssue(issue: JiraIssue, selectedIssue: JiraIssue | null): boolean {
  if (!selectedIssue || issue.key !== selectedIssue.key) {
    return false
  }
  return !selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId
}

export function TaskPageJiraBoard({
  formatUpdatedAt,
  getStatusTone,
  issues,
  onMoveIssue,
  onOpenIssue,
  onStartWorkspace,
  selectedIssue,
  showSiteContext,
  statusDirection = 'asc',
  statusOrder,
  updatingIssueKeys
}: TaskPageJiraBoardProps): React.JSX.Element {
  const [draggingIssueRefKey, setDraggingIssueRefKey] = useState<string | null>(null)
  const [dragOverSectionKey, setDragOverSectionKey] = useState<string | null>(null)
  const sections = useMemo(
    () => buildJiraBoardSections(issues, statusOrder, statusDirection),
    [issues, statusDirection, statusOrder]
  )

  const handleCardDragStart = (issue: JiraIssue, event: React.DragEvent<HTMLDivElement>): void => {
    if (updatingIssueKeys.has(jiraBoardIssueRefKey(issue))) {
      event.preventDefault()
      return
    }
    if (
      !writeJiraBoardIssueDragData(event.dataTransfer, { key: issue.key, siteId: issue.siteId })
    ) {
      event.preventDefault()
      return
    }
    setDraggingIssueRefKey(jiraBoardIssueRefKey(issue))
  }

  const handleSectionDragOver = (
    section: TaskPageJiraBoardSection,
    event: React.DragEvent<HTMLElement>
  ): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverSectionKey(section.key)
  }

  const handleSectionDrop = (
    section: TaskPageJiraBoardSection,
    event: React.DragEvent<HTMLElement>
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragOverSectionKey(null)

    const payload = readJiraBoardIssueDragData(event.dataTransfer)
    const issue =
      payload.status === 'issue'
        ? issues.find((item) => matchesDragRef(item, payload.ref))
        : payload.status === 'hidden'
          ? issues.find((item) => jiraBoardIssueRefKey(item) === draggingIssueRefKey)
          : undefined
    if (
      !issue ||
      updatingIssueKeys.has(jiraBoardIssueRefKey(issue)) ||
      section.statusIds.includes(issue.status.id) ||
      issue.status.name === section.label
    ) {
      return
    }
    void onMoveIssue(issue, section)
  }

  return (
    // Why: kanban lanes sit on one horizontal row — Jira boards commonly have
    // more columns than fit the panel, so the board scrolls sideways instead
    // of wrapping columns into a grid.
    <div className="flex min-w-0 items-start gap-3 overflow-x-auto p-3 scrollbar-sleek">
      {sections.map((section) => {
        const sectionTone = section.issues[0]
          ? getStatusTone(section.issues[0].status.categoryKey)
          : null
        return (
          <section
            key={section.key}
            onDragOver={(event) => handleSectionDragOver(section, event)}
            onDrop={(event) => handleSectionDrop(section, event)}
            className={cn(
              'w-72 shrink-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
              dragOverSectionKey === section.key && 'border-ring/70 ring-1 ring-ring/70'
            )}
          >
            <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
              <span
                className={cn(
                  'inline-flex min-w-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  sectionTone ?? 'border-border/50 bg-muted/35 text-muted-foreground'
                )}
              >
                <span className="truncate">{section.label || '—'}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">{section.issues.length}</span>
            </div>
            <div className="min-h-16 space-y-2 p-2">
              {section.issues.length === 0 ? (
                <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-border/50 text-[11px] text-muted-foreground">
                  {translate('auto.components.TaskPage.jiraBoardEmptyColumn', 'No issues')}
                </div>
              ) : null}
              {section.issues.map((issue) => {
                const refKey = jiraBoardIssueRefKey(issue)
                const selected = isSelectedIssue(issue, selectedIssue)
                const dragging = draggingIssueRefKey === refKey
                const updating = updatingIssueKeys.has(refKey)
                const labels = issue.labels.slice(0, 2)
                const contextLabel =
                  showSiteContext && issue.siteName
                    ? `${issue.siteName} / ${issue.project.key}`
                    : issue.project.key
                return (
                  <div
                    key={refKey}
                    role="button"
                    tabIndex={0}
                    draggable={!updating}
                    aria-current={selected ? 'true' : undefined}
                    data-current={selected ? 'true' : undefined}
                    aria-disabled={updating ? 'true' : undefined}
                    onDragStart={(event) => handleCardDragStart(issue, event)}
                    onDragEnd={() => {
                      setDraggingIssueRefKey(null)
                      setDragOverSectionKey(null)
                    }}
                    onClick={() => onOpenIssue(issue)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) {
                        return
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenIssue(issue)
                      }
                    }}
                    className={cn(
                      'group/card cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      !updating && 'cursor-grab active:cursor-grabbing',
                      selected && 'bg-accent',
                      dragging && 'opacity-50',
                      updating && 'cursor-wait opacity-70'
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                          <span className="truncate">{issue.key}</span>
                          {issue.priority ? (
                            <span className="truncate font-sans text-[10px]">
                              {issue.priority.name}
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                          {issue.title}
                        </h3>
                      </div>
                      <div className="flex shrink-0 items-center gap-1 md:opacity-0 md:transition-opacity md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100">
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
                                'auto.components.TaskPage.ff90d0abc7',
                                'Start workspace from {{value0}}',
                                { value0: issue.key }
                              )}
                            >
                              <ArrowRight className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
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
                              aria-label={translate(
                                'auto.components.TaskPage.4ac8ff2275',
                                'Open {{value0}} in Jira',
                                { value0: issue.key }
                              )}
                            >
                              <ExternalLink className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>
                            {translate('auto.components.TaskPage.eee68073b2', 'Open in Jira')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    {labels.length > 0 ? (
                      <div className="mt-1.5 flex min-w-0 items-center gap-1">
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
                    <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {issue.assignee?.avatarUrl ? (
                          <img
                            src={issue.assignee.avatarUrl}
                            alt={issue.assignee.displayName}
                            className="size-4 shrink-0 rounded-full"
                          />
                        ) : (
                          <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[9px]">
                            {issue.assignee?.displayName?.slice(0, 1) ?? '-'}
                          </span>
                        )}
                        <span className="truncate">
                          {issue.assignee?.displayName ??
                            translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="max-w-[120px] truncate text-[10px]">{contextLabel}</span>
                        <span>{formatUpdatedAt(issue.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
