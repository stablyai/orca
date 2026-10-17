import React from 'react'
import { cn } from '@/lib/utils'
import ProjectBoardCard from './ProjectBoardCard'
import { chipStyle, singleSelectChipColors } from './project-cell-chip-colors'
import type { ProjectBoardColumn } from '../../../../shared/github/project-board-columns'
import type { GitHubProjectField, GitHubProjectRow } from '../../../../shared/github/project-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export const BOARD_COLUMN_WIDTH_PX = 272
export const BOARD_CARD_DRAG_MIME = 'application/x-orca-project-row'

export type BoardCardOptions = {
  fields: GitHubProjectField[]
  showAssignees: boolean
  draggable: boolean
  sourceHost?: string
  sourceTarget: RuntimeClientTarget
  onOpenDialog?: (row: GitHubProjectRow) => void
}

export function BoardColumnHeader({
  column,
  count
}: {
  column: ProjectBoardColumn
  count: number
}): React.JSX.Element {
  const colors = column.color ? singleSelectChipColors(column.color) : null
  return (
    <div className="flex flex-none items-center gap-1.5 px-2.5 py-2 text-xs">
      {colors ? (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-[var(--github-project-chip-fg-light)] dark:bg-[var(--github-project-chip-fg-dark)]"
          style={{
            ...chipStyle(colors),
            boxShadow: `0 0 0 3px ${colors.bg}`
          }}
        />
      ) : null}
      <span className="truncate font-medium">{column.label}</span>
      <span className="rounded-full border border-border/50 bg-background px-1.5 text-[11px] text-muted-foreground">
        {count}
      </span>
    </div>
  )
}

/** A droppable board surface: a whole column, or one column's cell inside a swimlane. */
export function BoardDropTarget({
  laneKey,
  column,
  highlighted,
  testId,
  ariaLabel,
  fillHeight,
  onDragEnter,
  onDragLeaveOrEnd,
  children
}: {
  /** Null outside swimlanes. */
  laneKey: string | null
  column: ProjectBoardColumn
  highlighted: boolean
  testId: string
  ariaLabel: string
  fillHeight: boolean
  onDragEnter: () => void
  onDragLeaveOrEnd: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="list"
      aria-label={ariaLabel}
      data-testid={testId}
      data-board-lane-key={laneKey ?? undefined}
      data-board-column-key={column.key}
      className={cn(
        'flex shrink-0 flex-col rounded-lg border bg-muted/20',
        fillHeight ? 'h-full min-h-0' : 'min-h-16',
        highlighted && column.dropValue !== undefined
          ? 'border-ring/60 bg-accent/40'
          : 'border-border/50'
      )}
      style={{ width: BOARD_COLUMN_WIDTH_PX }}
      onDragOver={(event) => {
        if (
          column.dropValue !== undefined &&
          event.dataTransfer.types.includes(BOARD_CARD_DRAG_MIME)
        ) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          onDragEnter()
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          onDragLeaveOrEnd()
        }
      }}
    >
      {children}
    </div>
  )
}

export function BoardCardList({
  rows,
  scrolls,
  options
}: {
  rows: GitHubProjectRow[]
  /** Standalone columns scroll their own cards; swimlane cells grow with the lane. */
  scrolls: boolean
  options: BoardCardOptions
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 px-2 pb-2',
        scrolls ? 'min-h-0 flex-1 overflow-y-auto scrollbar-sleek' : 'pt-2'
      )}
    >
      {rows.map((row) => (
        <ProjectBoardCard
          key={row.id}
          row={row}
          draggable={options.draggable && row.itemType !== 'REDACTED'}
          fields={options.fields}
          showAssignees={options.showAssignees}
          sourceHost={options.sourceHost}
          sourceTarget={options.sourceTarget}
          onOpenDialog={() => options.onOpenDialog?.(row)}
          onDragStart={(event) => {
            event.dataTransfer.setData(BOARD_CARD_DRAG_MIME, row.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
        />
      ))}
    </div>
  )
}
