import React, { useState } from 'react'
import { ChevronDown, FolderKanban } from 'lucide-react'
import { toast } from 'sonner'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { BeadsIssue, BeadsIssueStatus } from '../../../shared/beads-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  BEADS_STATUS_ICONS,
  BEADS_STATUS_ORDER,
  getBeadsStatusLabels,
  getBeadsStatusTone
} from './task-page-beads-status-visuals'

// Why: exact column-label classes from GHEditSection's top-columns layout.
const META_LABEL_CLASS =
  'mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground'
const META_EMPTY_CLASS = 'text-[12px] text-muted-foreground'
const META_CHIP_CLASS =
  'inline-flex items-center rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground'

function BeadsDetailStatusDropdown({
  issue,
  sourceContext,
  onIssueChange
}: {
  issue: BeadsIssue
  sourceContext: TaskSourceContext
  onIssueChange: (issue: BeadsIssue) => void
}): React.JSX.Element {
  const updateStatus = useAppStore((s) => s.updateBeadsIssueStatus)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const statusLabels = getBeadsStatusLabels()
  const ShownIcon = BEADS_STATUS_ICONS[issue.status]

  const handleStatusChange = (next: BeadsIssueStatus): void => {
    if (pending || next === issue.status) {
      return
    }
    const previous = issue
    setPending(true)
    // Why: optimistic — the store patches the list cache; the dialog's copy patches here.
    onIssueChange({ ...issue, status: next })
    updateStatus(sourceContext, issue.id, next)
      .then((updated) => onIssueChange(updated))
      .catch(() => {
        onIssueChange(previous)
        toast.error(
          translate('auto.components.TaskPage.beadsStatusUpdateFailed', 'Failed to update status')
        )
      })
      .finally(() => setPending(false))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          className={cn(
            'inline-flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50',
            getBeadsStatusTone(issue.status)
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <ShownIcon className="size-3.5" />
            {statusLabels[issue.status]}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {BEADS_STATUS_ORDER.map((status) => {
          const Icon = BEADS_STATUS_ICONS[status]
          return (
            <button
              key={status}
              type="button"
              onClick={() => {
                handleStatusChange(status)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                issue.status === status && 'bg-accent/50'
              )}
            >
              <Icon className="size-4 text-muted-foreground" />
              {statusLabels[status]}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/** Property columns above the beads issue body, mirroring GHEditSection's top-columns meta band. */
export function BeadsItemDetailMeta({
  issue,
  sourceContext,
  attachedWorkspaceLabel,
  onIssueChange
}: {
  issue: BeadsIssue
  sourceContext: TaskSourceContext
  attachedWorkspaceLabel: string | null
  onIssueChange: (issue: BeadsIssue) => void
}): React.JSX.Element {
  return (
    <aside className="grid grid-cols-2 gap-x-6 gap-y-5 text-[13px] sm:grid-cols-4">
      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.GitHubItemDialog.00ccdf9b5a', 'Status')}
        </div>
        <BeadsDetailStatusDropdown
          issue={issue}
          sourceContext={sourceContext}
          onIssueChange={onIssueChange}
        />
      </section>

      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.GitHubItemDialog.83ac703dda', 'Assignees')}
        </div>
        {issue.assignee ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground">
              {issue.assignee.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
              {issue.assignee}
            </span>
          </div>
        ) : (
          <div className={META_EMPTY_CLASS}>
            {translate('auto.components.GitHubItemDialog.c67de9e2fe', 'No one assigned')}
          </div>
        )}
      </section>

      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.GitHubItemDialog.217e55d87c', 'Labels')}
        </div>
        {issue.labels.length === 0 ? (
          <div className={META_EMPTY_CLASS}>
            {translate('auto.components.GitHubItemDialog.886a64b081', 'None yet')}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {issue.labels.map((name) => (
              <span key={name} className={META_CHIP_CLASS}>
                {name}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.GitHubItemDialog.2e4d806c92', 'Workspace')}
        </div>
        {attachedWorkspaceLabel ? (
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <FolderKanban className="size-3.5 shrink-0" />
            <span className="truncate">{attachedWorkspaceLabel}</span>
          </div>
        ) : (
          <div className={META_EMPTY_CLASS}>
            {translate('auto.components.GitHubItemDialog.886a64b081', 'None yet')}
          </div>
        )}
      </section>

      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
        </div>
        {Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? (
          <span className={META_CHIP_CLASS}>P{issue.priority}</span>
        ) : (
          <div className={META_EMPTY_CLASS}>
            {translate('auto.components.GitHubItemDialog.886a64b081', 'None yet')}
          </div>
        )}
      </section>

      <section className="min-w-0">
        <div className={META_LABEL_CLASS}>
          {translate('auto.components.TaskPage.beadsFilterType', 'Type')}
        </div>
        <div className="text-[12px] font-medium text-foreground">{issue.issueType}</div>
      </section>
    </aside>
  )
}
