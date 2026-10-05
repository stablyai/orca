import React, { useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import { getMantisBTStatusTone } from '@/components/task-page-mantisbt-status-tone'

export type TaskPageMantisBTIssueSection = {
  key: string
  label: string
  issues: MantisBTIssue[]
}

type TaskPageMantisBTIssueListProps = {
  formatUpdatedAt: (updatedAt: string) => string
  issues: MantisBTIssue[]
  onOpenIssue: (issue: MantisBTIssue) => void
  onStartWorkspace: (issue: MantisBTIssue) => void
  selectedIssue: MantisBTIssue | null
  showSiteContext: boolean
  statusDirection?: 'asc' | 'desc'
}

// Why: no per-project status-order RPC exists for MantisBT (unlike Jira's
// board-column fetch), so sections are ranked by the fixed default numeric
// status id — a custom install may reorder the enum, but this still
// degrades to a stable, if imperfect, grouping order.
export function groupMantisBTIssuesByStatus(
  issues: readonly MantisBTIssue[],
  statusDirection: 'asc' | 'desc' = 'asc'
): TaskPageMantisBTIssueSection[] {
  const sections = new Map<string, TaskPageMantisBTIssueSection>()
  for (const issue of issues) {
    const key = `status:${issue.status.name}`
    const section = sections.get(key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(key, { key, label: issue.status.name, issues: [issue] })
    }
  }
  const sortedSections = [...sections.values()].sort((a, b) => {
    const rankA = Number(a.issues[0]?.status.id ?? Number.POSITIVE_INFINITY)
    const rankB = Number(b.issues[0]?.status.id ?? Number.POSITIVE_INFINITY)
    return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB
  })
  return statusDirection === 'desc' ? sortedSections.toReversed() : sortedSections
}

function isSelectedIssue(issue: MantisBTIssue, selectedIssue: MantisBTIssue | null): boolean {
  if (!selectedIssue || issue.id !== selectedIssue.id) {
    return false
  }
  return !selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId
}

function MantisBTIssueRow({
  formatUpdatedAt,
  issue,
  onOpenIssue,
  onStartWorkspace,
  selected,
  showSiteContext
}: {
  formatUpdatedAt: (updatedAt: string) => string
  issue: MantisBTIssue
  onOpenIssue: (issue: MantisBTIssue) => void
  onStartWorkspace: (issue: MantisBTIssue) => void
  selected: boolean
  showSiteContext: boolean
}): React.JSX.Element {
  const handlerName = issue.handler?.realName || issue.handler?.name
  const contextLabel = showSiteContext && issue.siteName ? issue.siteName : issue.project.name

  return (
    // Why: the row contains action buttons, so a native button wrapper would
    // create invalid nested buttons; role + keyboard handling preserves access.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
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
        'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_120px_92px_64px] lg:grid-cols-[minmax(0,1.3fr)_132px_110px_140px_96px_64px]',
        selected && 'bg-accent'
      )}
    >
      <div className="min-w-0">
        <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
          {issue.summary}
        </h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 lg:!hidden">
          <span
            className={cn(
              'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
              getMantisBTStatusTone(issue.status.id)
            )}
          >
            <span className="truncate">{issue.status.name}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground max-md:!hidden">
            {issue.priority?.name ??
              translate('auto.components.TaskPage.713179dfdc', 'No priority')}
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {handlerName ?? translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 max-md:!hidden">
          <span className="max-w-[200px] truncate text-[10px] text-muted-foreground">
            {contextLabel}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            getMantisBTStatusTone(issue.status.id)
          )}
        >
          <span className="truncate">{issue.status.name}</span>
        </span>
      </div>

      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {issue.priority?.name ?? translate('auto.components.TaskPage.713179dfdc', 'No priority')}
      </span>

      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
          {handlerName?.slice(0, 1) ?? '-'}
        </span>
        <span className="truncate">
          {handlerName ?? translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-lg:!hidden">
            {formatUpdatedAt(issue.updatedAt)}
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
                'auto.components.TaskPage.mantisbtStartWorkspaceFrom',
                'Start workspace from #{{value0}}',
                { value0: issue.id }
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
                window.api.shell.openUrl(issue.url)
              }}
              aria-label={translate(
                'auto.components.TaskPage.mantisbtOpenInMantisBT',
                'Open #{{value0}} in MantisBT',
                { value0: issue.id }
              )}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.mantisbtOpenInMantisBTShort', 'Open in MantisBT')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function TaskPageMantisBTIssueList({
  formatUpdatedAt,
  issues,
  onOpenIssue,
  onStartWorkspace,
  selectedIssue,
  showSiteContext,
  statusDirection = 'asc'
}: TaskPageMantisBTIssueListProps): React.JSX.Element {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const sections = useMemo(
    () => groupMantisBTIssuesByStatus(issues, statusDirection),
    [issues, statusDirection]
  )

  return (
    <div className="divide-y divide-border/50">
      {sections.map((section) => {
        const open = !collapsedGroups.has(section.key)
        return (
          <Collapsible
            key={section.key}
            open={open}
            onOpenChange={(nextOpen) => {
              setCollapsedGroups((current) => {
                const next = new Set(current)
                if (nextOpen) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-none bg-muted/35 px-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {section.issues.length}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="divide-y divide-border/50 border-t border-border/50">
                {section.issues.map((issue) => (
                  <MantisBTIssueRow
                    key={`${issue.siteId ?? 'site'}:${issue.id}`}
                    formatUpdatedAt={formatUpdatedAt}
                    issue={issue}
                    onOpenIssue={onOpenIssue}
                    onStartWorkspace={onStartWorkspace}
                    selected={isSelectedIssue(issue, selectedIssue)}
                    showSiteContext={showSiteContext}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
