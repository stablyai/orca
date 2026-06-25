import React from 'react'
import { Pin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Repo, Worktree } from '../../../../shared/types'
import WorktreeCard from './WorktreeCard'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isSelected: boolean
  selectedWorktrees?: readonly Worktree[]
  nativeDragEnabled?: boolean
  onActivate: () => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
}

function WorkspaceKanbanCard({
  worktree,
  repo,
  isActive,
  isSelected,
  selectedWorktrees,
  nativeDragEnabled = true,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect
}: WorkspaceKanbanCardProps): React.JSX.Element {
  const contextWorktrees =
    isSelected && selectedWorktrees && selectedWorktrees.length > 0 ? selectedWorktrees : undefined

  return (
    <div
      className="relative rounded-lg data-[workspace-board-card-area-selected=true]:ring-1 data-[workspace-board-card-area-selected=true]:ring-worktree-sidebar-ring/40"
      data-workspace-board-card-id={worktree.id}
      data-workspace-board-card-mode="detailed"
      data-workspace-board-card-selected={isSelected ? 'true' : 'false'}
      data-workspace-board-pointer-draggable={nativeDragEnabled ? undefined : 'true'}
    >
      {worktree.isPinned ? (
        <Badge
          variant="outline"
          className="pointer-events-none absolute right-2 top-1.5 z-10 flex size-4 items-center justify-center rounded-full bg-background/90 p-0 text-muted-foreground"
          aria-label={translate('auto.components.sidebar.WorkspaceKanbanCard.cefae8983e', 'Pinned')}
        >
          <Pin className="size-2.5" />
        </Badge>
      ) : null}
      <WorktreeCard
        worktree={worktree}
        repo={repo}
        isActive={isActive}
        isMultiSelected={isSelected}
        selectedWorktrees={contextWorktrees}
        nativeDragEnabled={nativeDragEnabled}
        onActivate={onActivate}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={(event) => onContextMenuSelect(event, worktree)}
      />
    </div>
  )
}

export default React.memo(WorkspaceKanbanCard)
