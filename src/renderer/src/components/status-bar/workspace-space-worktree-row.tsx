import { AlertTriangle, FolderSearch, GitBranch, Server, Trash2 } from 'lucide-react'
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
import { getRevealInFileManagerLabel, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { HoverCard, HoverCardTrigger } from '../ui/hover-card'
import {
  formatBytes,
  getWorkspaceSpaceBranchLabel,
  getWorkspaceSpaceScanDateTimeLabel
} from './workspace-space-format'
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
import { describeWorktreeDeleteError } from '../sidebar/worktree-delete-error-display'
import { formatShortTimeAgo } from '@/lib/short-time-ago'

export function WorkspaceSpaceWorktreeRow({
  worktree,
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
  const deleteError = deleteState?.error ? describeWorktreeDeleteError(deleteState.error) : null
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
        'grid w-full cursor-pointer grid-cols-[1.75rem_minmax(0,1.4fr)_minmax(5rem,0.55fr)_5.5rem_6rem_9.5rem] items-center gap-2 border-b border-border/45 px-3 py-1 text-left text-xs transition-colors last:border-b-0 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

      <div className="flex min-w-0 items-center gap-1.5" title={worktree.path}>
        <span className="min-w-0 truncate font-medium">{worktree.displayName}</span>
        {worktree.isRemote ? <Server className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        {worktree.isSparse ? (
          <Badge variant="outline">
            {translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.9155381019',
              'Sparse'
            )}
          </Badge>
        ) : null}
        <GitBranch className="size-3 shrink-0 text-muted-foreground" />
        <span className="max-w-24 shrink-0 truncate text-muted-foreground">
          {getWorkspaceSpaceBranchLabel(worktree)}
        </span>
        {deleteError ? (
          <div className="flex min-w-0 items-center gap-1 text-destructive">
            <AlertTriangle className="size-3 shrink-0" />
            <span className="min-w-0 truncate" title={deleteError}>
              {deleteError}
            </span>
            {canForceDelete ? (
              <Button
                type="button"
                variant="destructive"
                size="xs"
                onClick={handleForceDelete}
                className="h-6 shrink-0"
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

      <div className="min-w-0 truncate" title={worktree.repoPath}>
        {worktree.repoDisplayName}
      </div>

      <div
        className="truncate text-right tabular-nums text-muted-foreground"
        title={
          worktree.lastActivityAt > 0
            ? getWorkspaceSpaceScanDateTimeLabel(worktree.lastActivityAt)
            : undefined
        }
      >
        {worktree.lastActivityAt > 0 ? formatShortTimeAgo(worktree.lastActivityAt) : '—'}
      </div>

      <div className="truncate text-right font-medium tabular-nums">
        {worktree.status === 'ok' ? formatBytes(worktree.sizeBytes) : '—'}
      </div>

      <div className="flex items-center justify-end gap-1">
        {canDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('workspaceSpace.deleteOne', 'Delete {{value0}}', {
              value0: worktree.displayName
            })}
            title={translate('workspaceSpace.deleteOne', 'Delete {{value0}}', {
              value0: worktree.displayName
            })}
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            void revealInFileManager(worktree.path, worktree.executionHostId ?? 'unresolved')
          }
        >
          <FolderSearch className="size-3.5" />
          {getRevealInFileManagerLabel()}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={!canDelete} onSelect={onDelete}>
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
