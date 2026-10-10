import { AlertTriangle, GitBranch, Server, Trash2 } from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { HoverCard, HoverCardTrigger } from '../ui/hover-card'
import { formatBytes, getWorkspaceSpaceBranchLabel } from './workspace-space-format'
import { isWorkspaceSpaceRowReadyToDelete } from './workspace-space-presentation'
import { translate } from '@/i18n/i18n'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type {
  WorkspaceGitRefreshState,
  WorkspaceSpaceDeleteState
} from './workspace-space-manager-state-types'
import { CheckButton } from './workspace-space-selection-controls'
import { WorkspaceDecisionHoverCard } from './workspace-space-decision-hover-card'
import { WorkspaceSpaceStatusBadge } from './workspace-space-status-badge'
import { WorkspaceSpaceSizeBar } from './workspace-space-breakdown-list'

export function WorkspaceSpaceWorktreeRow({
  worktree,
  maxSize,
  selected,
  inspected,
  decisionDetails,
  gitRefreshState,
  deleteState,
  onToggleSelected,
  onInspect,
  onOpenWorkspace,
  onDelete,
  onForceDelete
}: {
  worktree: WorkspaceSpaceWorktree
  maxSize: number
  selected: boolean
  inspected: boolean
  decisionDetails: WorkspaceDecisionDetails
  gitRefreshState?: WorkspaceGitRefreshState
  deleteState?: WorkspaceSpaceDeleteState
  onToggleSelected: () => void
  onInspect: () => void
  onOpenWorkspace: () => void
  onDelete: () => void
  onForceDelete: () => void
}): React.JSX.Element {
  const isDeleting = deleteState?.isDeleting ?? false
  const deleteError = deleteState?.error ?? null
  const canForceDelete = deleteState?.canForceDelete ?? false
  const canDelete = isWorkspaceSpaceRowReadyToDelete(worktree, decisionDetails) && !isDeleting
  const handleForceDelete = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onForceDelete()
  }
  const row = (
    <div
      role="button"
      tabIndex={0}
      aria-busy={isDeleting}
      onClick={onInspect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        event.preventDefault()
        onInspect()
      }}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[1.75rem_minmax(0,1.25fr)_minmax(9rem,0.55fr)_8rem_9.5rem] items-center gap-3 border-b border-border/45 px-3 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        inspected && 'bg-accent/55',
        isDeleting && 'cursor-wait opacity-50 grayscale hover:bg-transparent'
      )}
    >
      <CheckButton
        checked={canDelete && selected}
        disabled={!canDelete}
        label={translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.0d1c78d749',
          'Select {{value0}}',
          { value0: worktree.displayName }
        )}
        onClick={onToggleSelected}
      />

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{worktree.displayName}</span>
          {worktree.isRemote ? (
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          {worktree.isSparse ? (
            <Badge variant="outline">
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.9155381019',
                'Sparse'
              )}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{getWorkspaceSpaceBranchLabel(worktree)}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {worktree.path}
        </div>
        {deleteError ? (
          <div className="mt-2 flex min-w-0 items-start gap-2 rounded-md border border-destructive/35 bg-destructive/8 px-2 py-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 flex-1 break-words" title={deleteError}>
              {deleteError}
            </span>
            {canForceDelete ? (
              <Button
                type="button"
                variant="destructive"
                size="xs"
                onClick={handleForceDelete}
                className="h-6 shrink-0 gap-1 px-2"
              >
                <Trash2 className="size-3" />
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.a998501630',
                  'Force'
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-w-0 text-xs">
        <div className="truncate font-medium">{worktree.repoDisplayName}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {worktree.repoPath}
        </div>
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="text-right text-sm font-medium tabular-nums">
          {worktree.status === 'ok' ? formatBytes(worktree.sizeBytes) : '—'}
        </div>
        <WorkspaceSpaceSizeBar value={worktree.sizeBytes} max={maxSize} />
      </div>

      <div className="flex justify-end">
        <HoverCard openDelay={250} closeDelay={120}>
          <HoverCardTrigger asChild>
            <span
              className="inline-flex"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <WorkspaceSpaceStatusBadge
                worktree={worktree}
                decisionDetails={decisionDetails}
                deleteState={deleteState}
              />
            </span>
          </HoverCardTrigger>
          <WorkspaceDecisionHoverCard
            worktree={worktree}
            details={decisionDetails}
            gitRefreshState={gitRefreshState}
            onOpenWorkspace={onOpenWorkspace}
          />
        </HoverCard>
      </div>
    </div>
  )

  if (!canDelete) {
    return row
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {translate(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.792a214457',
            'Delete workspace'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
