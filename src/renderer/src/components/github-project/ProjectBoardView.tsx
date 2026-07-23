import React, { useMemo } from 'react'
import { FileText, GitPullRequest, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { chipStyle, singleSelectChipColors } from './single-select-chip-colors'
import { sortRows } from '../../../../shared/github-project-group-sort'
import {
  buildBoardColumns,
  NO_VALUE_COLUMN_KEY,
  resolveBoardGroupField,
  type ProjectBoardColumn
} from '../../../../shared/github-project-board-columns'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github-project-types'
import { translate } from '@/i18n/i18n'

type Props = {
  table: GitHubProjectTable
  onOpenDialog?: (row: GitHubProjectRow) => void
}

export default function ProjectBoardView({ table, onOpenDialog }: Props): React.JSX.Element {
  const groupField = useMemo(() => resolveBoardGroupField(table.selectedView), [table.selectedView])
  const columns = useMemo(
    () => (groupField ? buildBoardColumns(groupField, sortRows(table, table.rows)) : []),
    [groupField, table]
  )

  if (!groupField) {
    return (
      <div className="flex min-h-[120px] flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectBoardView.no-group-field',
          'This board has no single-select field to group by.'
        )}
      </div>
    )
  }
  if (table.rows.length === 0) {
    return (
      <div className="flex min-h-[120px] flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectBoardView.empty',
          "No items match this view's filter."
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-3 scrollbar-sleek">
      {columns.map((column) => (
        <BoardColumn
          key={column.key}
          column={column}
          // Why: the shared column builder can't reach translate(); swap its
          // English no-value label for the localized one here.
          label={
            column.key === NO_VALUE_COLUMN_KEY
              ? translate(
                  'auto.components.github.project.ProjectBoardView.no-value-column',
                  'No {{value0}}',
                  { value0: groupField.name }
                )
              : column.label
          }
          onOpenDialog={onOpenDialog}
        />
      ))}
    </div>
  )
}

function BoardColumn({
  column,
  label,
  onOpenDialog
}: {
  column: ProjectBoardColumn
  label: string
  onOpenDialog?: (row: GitHubProjectRow) => void
}): React.JSX.Element {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg border border-border/50 bg-muted/20">
      <div className="flex flex-none items-center gap-2 border-b border-border/50 px-3 py-2">
        {column.color ? (
          <span
            className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]"
            style={chipStyle(singleSelectChipColors(column.color))}
          >
            {label}
          </span>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
        )}
        <span className="ml-auto rounded-full border border-border/50 bg-background px-1.5 text-[10px] text-muted-foreground">
          {column.rows.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 scrollbar-sleek">
        {column.rows.map((row) => (
          <BoardCard key={row.id} row={row} onOpenDialog={onOpenDialog} />
        ))}
      </div>
    </div>
  )
}

function BoardCard({
  row,
  onOpenDialog
}: {
  row: GitHubProjectRow
  onOpenDialog?: (row: GitHubProjectRow) => void
}): React.JSX.Element {
  // Why: mirror TitleCell's glyph rules — PRs get an icon, issues read as
  // issues via #number; drafts/restricted get their static glyph.
  const glyph =
    row.itemType === 'PULL_REQUEST' ? (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    ) : row.itemType === 'DRAFT_ISSUE' ? (
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
    ) : row.itemType === 'REDACTED' ? (
      <Lock className="size-3.5 shrink-0 text-muted-foreground" />
    ) : null
  const interactive = row.itemType === 'ISSUE' || row.itemType === 'PULL_REQUEST'
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        {glyph}
        {row.content.repository ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {row.content.repository}
          </span>
        ) : null}
        {row.content.number != null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">#{row.content.number}</span>
        ) : null}
      </div>
      <div className="line-clamp-2 text-sm font-medium">
        {row.itemType === 'REDACTED'
          ? translate(
              'auto.components.github.project.ProjectBoardView.restricted',
              'Restricted item'
            )
          : row.content.title}
      </div>
      {row.content.assignees.length > 0 ? (
        <div className="flex items-center gap-1">
          {row.content.assignees.slice(0, 5).map((user) =>
            user.avatarUrl ? (
              <img
                key={user.login}
                src={user.avatarUrl}
                alt={user.login}
                title={user.login}
                className="size-4 rounded-full border border-border/50"
              />
            ) : (
              <span key={user.login} className="text-[11px] text-muted-foreground">
                {user.login}
              </span>
            )
          )}
        </div>
      ) : null}
    </>
  )
  if (!interactive) {
    return (
      <div className="w-full space-y-1.5 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpenDialog?.(row)}
      className={cn(
        'w-full space-y-1.5 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left',
        // Why: match ProjectRow's hover tint so table and board rows read as one design.
        'cursor-pointer transition-colors hover:bg-accent/60'
      )}
    >
      {body}
    </button>
  )
}
