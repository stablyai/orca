import React from 'react'
import { ArrowRight, Copy, EllipsisVertical, Eye, FolderKanban, Plus } from 'lucide-react'

import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  findBeadsIssueWorkspaceAttachment,
  getBeadsIssueWorkspaceAttachmentLabel
} from '@/lib/beads-issue-workspace-attachment'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../shared/types'
import type { TaskPageBeadsIssueRow, TaskPageBeadsListState } from './task-page-beads-issues'
import {
  getBeadsListNoticeCopy,
  type TaskPageBeadsRepoNotice
} from './task-page-beads-list-notices'
import { BeadsRepoNoticeRows } from './task-page-beads-repo-notice-rows'
import { copyBeadsIssueText, openOrStartBeadsWorkspace } from './task-page-beads-row-actions'
import { BeadsStatusCell } from './task-page-beads-status-cell'
import { BEADS_STATUS_ICONS } from './task-page-beads-status-visuals'

// Why: exact mirror of the GitHub issues table (TaskPage GITHUB_TASK_* constants) —
// same grid template, sticky offsets, and opaque surfaces so both lists render identically.
const BEADS_TASK_GRID_CLASS =
  'min-w-[790px] grid-cols-[72px_minmax(320px,1fr)_84px_100px_92px_122px]'
const BEADS_TASK_ROW_SURFACE_CLASS = 'bg-background transition-colors'
const BEADS_TASK_ROW_HOVER_SURFACE_CLASS = 'group-hover/beads-task-row:bg-accent'
const BEADS_TASK_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--muted)_25%,var(--background))]'
const BEADS_TASK_STICKY_ID_HEADER_CLASS = cn(
  'sticky left-3 z-30 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  BEADS_TASK_HEADER_SURFACE_CLASS
)
const BEADS_TASK_STICKY_TITLE_HEADER_CLASS = cn(
  'sticky left-[92px] z-30 flex items-center border-r border-border/40 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  BEADS_TASK_HEADER_SURFACE_CLASS
)
const BEADS_TASK_STICKY_ID_CELL_CLASS = cn(
  'sticky left-3 z-20 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  BEADS_TASK_ROW_SURFACE_CLASS,
  BEADS_TASK_ROW_HOVER_SURFACE_CLASS
)
const BEADS_TASK_STICKY_TITLE_CELL_CLASS = cn(
  'sticky left-[92px] z-20 flex min-w-0 flex-col justify-center border-r border-border/40 pr-2 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  BEADS_TASK_ROW_SURFACE_CLASS,
  BEADS_TASK_ROW_HOVER_SURFACE_CLASS
)

export type TaskPageBeadsRepoBadge = { displayName: string; badgeColor: string }

type TaskPageBeadsIssueListProps = {
  allWorktrees: readonly Worktree[]
  formatUpdatedAt: (updatedAt: string) => string
  listState: TaskPageBeadsListState
  onRetry: () => void
  onStartWorkspace: (row: TaskPageBeadsIssueRow) => void
  onViewDetails: (row: TaskPageBeadsIssueRow) => void
  repoBadges: ReadonlyMap<string, TaskPageBeadsRepoBadge>
  repoNotices: readonly TaskPageBeadsRepoNotice[]
  rows: TaskPageBeadsIssueRow[]
  selectedRepoCount: number
}

function BeadsAssigneesCell({ assignee }: { assignee: string | undefined }): React.JSX.Element {
  if (!assignee) {
    return <span className="text-xs text-muted-foreground/60">-</span>
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        title={assignee}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground"
      >
        {assignee.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 truncate">{assignee}</span>
    </span>
  )
}

function BeadsIssueRow({
  attachedWorkspace,
  formatUpdatedAt,
  onStartWorkspace,
  onViewDetails,
  repoBadge,
  row,
  selectedRepoCount
}: {
  attachedWorkspace: Worktree | null
  formatUpdatedAt: (updatedAt: string) => string
  onStartWorkspace: (row: TaskPageBeadsIssueRow) => void
  onViewDetails: (row: TaskPageBeadsIssueRow) => void
  repoBadge: TaskPageBeadsRepoBadge | null
  row: TaskPageBeadsIssueRow
  selectedRepoCount: number
}): React.JSX.Element {
  const { issue } = row
  const IdIcon = BEADS_STATUS_ICONS[issue.status]
  const attachedWorkspaceLabel = attachedWorkspace
    ? getBeadsIssueWorkspaceAttachmentLabel(attachedWorkspace)
    : null
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onViewDetails(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onViewDetails(row)
        }
      }}
      className={cn(
        'group/beads-task-row grid min-h-12 cursor-pointer gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        BEADS_TASK_GRID_CLASS
      )}
    >
      <div className={BEADS_TASK_STICKY_ID_CELL_CLASS}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={issue.id}
              className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/40 px-1.5 py-0.5 text-muted-foreground"
            >
              <IdIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate font-mono text-[11px] font-normal">{issue.id}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {issue.id}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className={BEADS_TASK_STICKY_TITLE_CELL_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-medium text-foreground">{issue.title}</h3>
          {selectedRepoCount > 1 && repoBadge ? (
            <RepoBadgeLabel
              name={repoBadge.displayName}
              color={repoBadge.badgeColor}
              badgeClassName="size-1.5"
              className="shrink-0 text-[11px] text-muted-foreground"
            />
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-muted-foreground">
          {issue.createdBy ? <span className="truncate">{issue.createdBy}</span> : null}
          {selectedRepoCount === 1 && repoBadge ? <span>{repoBadge.displayName}</span> : null}
          {attachedWorkspaceLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <FolderKanban className="size-3 shrink-0" />
              <span className="truncate">{attachedWorkspaceLabel}</span>
            </span>
          ) : null}
          {issue.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="rounded-full border border-border/40 bg-muted/30 px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? (
            <span className="rounded-full border border-border/40 bg-muted/30 px-1.5 py-0 text-[10px] text-muted-foreground">
              P{issue.priority}
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-w-0 flex items-center text-xs text-muted-foreground">
        <BeadsAssigneesCell assignee={issue.assignee} />
      </div>

      <div className="flex items-center">
        <BeadsStatusCell row={row} />
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center text-[11px] text-muted-foreground">
            {formatUpdatedAt(issue.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(issue.updatedAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>

      <div className="flex items-center justify-start gap-1 lg:justify-end">
        <Button
          type="button"
          // Why: Open resumes an existing workspace — solid primary reads stronger than outline Start (new workspace).
          variant={attachedWorkspace ? 'default' : 'outline'}
          size="xs"
          data-contextual-tour-target="tasks-start-workspace"
          onClick={(event) => {
            event.stopPropagation()
            openOrStartBeadsWorkspace(row, onStartWorkspace)
          }}
          className={cn(
            'min-w-[72px] gap-1 font-semibold',
            attachedWorkspace ? 'shadow-xs' : 'bg-background/80'
          )}
          aria-label={
            attachedWorkspace
              ? translate('auto.components.TaskPage.2193a99ec1', 'Open workspace attached to issue')
              : translate('auto.components.TaskPage.e104fa3d3d', 'Start workspace from issue')
          }
        >
          {attachedWorkspace
            ? translate('auto.components.TaskPage.606a85c774', 'Open')
            : translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
          <ArrowRight className="size-3" />
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
              aria-label={translate('auto.components.TaskPage.66ae7330f6', 'More actions')}
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {attachedWorkspace ? (
              <DropdownMenuItem onSelect={() => onStartWorkspace(row)}>
                <Plus className="size-4" />
                {translate('auto.components.TaskPage.b6329379ca', 'Start new workspace')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onViewDetails(row)}>
              <Eye className="size-4" />
              {translate('auto.components.TaskPage.beadsViewDetails', 'View details')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void copyBeadsIssueText(
                  issue.id,
                  translate('auto.components.TaskPage.eb10c32872', 'ID')
                )
              }
            >
              <Copy className="size-4" />
              {translate('auto.components.TaskPage.beadsCopyId', 'Copy ID')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void copyBeadsIssueText(
                  issue.title,
                  translate('auto.components.TaskPage.16cba35bee', 'Title')
                )
              }
            >
              <Copy className="size-4" />
              {translate('auto.components.TaskPage.beadsCopyTitle', 'Copy title')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/** Beads issues table mirroring the GitHub issues table: same header, grid, sticky cells, and row chrome. */
export function TaskPageBeadsIssueList({
  allWorktrees,
  formatUpdatedAt,
  listState,
  onRetry,
  onStartWorkspace,
  onViewDetails,
  repoBadges,
  repoNotices,
  rows,
  selectedRepoCount
}: TaskPageBeadsIssueListProps): React.JSX.Element {
  // Why: banner rows accompany a renderable table; when nothing renders, the full-panel notice already carries the failure.
  const showRepoNotices =
    listState === 'ready' || listState === 'empty' || listState === 'empty-filtered'
  return (
    <div
      className="min-h-0 flex-initial overflow-auto scrollbar-sleek scrollbar-sleek-lg"
      style={{ scrollbarGutter: 'stable' }}
    >
      <div
        className={cn(
          'sticky top-0 z-40 grid h-8 gap-3 border-b border-border/50 px-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground [&>span]:flex [&>span]:items-center',
          BEADS_TASK_HEADER_SURFACE_CLASS,
          BEADS_TASK_GRID_CLASS
        )}
      >
        <span className={BEADS_TASK_STICKY_ID_HEADER_CLASS}>
          {translate('auto.components.TaskPage.eb10c32872', 'ID')}
        </span>
        <span className={BEADS_TASK_STICKY_TITLE_HEADER_CLASS}>
          {translate('auto.components.TaskPage.5eccb3c841', 'Title / Context')}
        </span>
        <span>{translate('auto.components.TaskPage.8aba10579d', 'Assignees')}</span>
        <span>{translate('auto.components.TaskPage.154b0fa623', 'Status')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>

      {showRepoNotices ? (
        <BeadsRepoNoticeRows
          notices={repoNotices}
          onRetry={onRetry}
          repoBadges={repoBadges}
          selectedRepoCount={selectedRepoCount}
        />
      ) : null}

      {listState === 'loading' ? (
        <div className="divide-y divide-border/40">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className={cn('grid min-h-12 gap-3 px-3 py-2.5', BEADS_TASK_GRID_CLASS)}>
              <div className={BEADS_TASK_STICKY_ID_CELL_CLASS}>
                <div className="h-6 w-16 animate-pulse rounded-md bg-muted/70" />
              </div>
              <div className={BEADS_TASK_STICKY_TITLE_CELL_CLASS}>
                <div className="h-3.5 w-3/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-1.5 h-3 w-2/5 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="flex items-center">
                <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="flex items-center">
                <div className="h-5 w-14 animate-pulse rounded-full bg-muted/70" />
              </div>
              <div className="flex items-center">
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="flex items-center justify-start lg:justify-end">
                <div className="h-7 w-16 animate-pulse rounded-md bg-muted/70" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {listState !== 'loading' && listState !== 'ready' ? (
        <div className="px-4 py-10 text-center">
          <p className="text-base font-medium text-foreground">
            {getBeadsListNoticeCopy(listState).title}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {getBeadsListNoticeCopy(listState).body}
          </p>
        </div>
      ) : null}

      {listState === 'ready' ? (
        <div className="divide-y divide-border/40">
          {rows.map((row) => (
            <BeadsIssueRow
              key={`${row.sourceContext.repoId ?? row.sourceContext.projectId}:${row.issue.id}`}
              attachedWorkspace={findBeadsIssueWorkspaceAttachment(
                allWorktrees,
                row.sourceContext.repoId,
                row.issue.id
              )}
              formatUpdatedAt={formatUpdatedAt}
              onStartWorkspace={onStartWorkspace}
              onViewDetails={onViewDetails}
              repoBadge={
                row.sourceContext.repoId ? (repoBadges.get(row.sourceContext.repoId) ?? null) : null
              }
              row={row}
              selectedRepoCount={selectedRepoCount}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
