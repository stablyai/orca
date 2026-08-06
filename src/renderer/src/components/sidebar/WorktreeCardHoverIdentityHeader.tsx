import React from 'react'
import { cn } from '@/lib/utils'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'

type WorktreeCardHoverIdentityHeaderProps = {
  branchName?: string
  workspaceTitle?: string
  identityOrder: 'workspace-first' | 'branch-first'
  workspaceTitleRenameDisabled: boolean
  onRenameWorkspaceTitle?: (displayName: string) => Promise<void> | void
  onWorkspaceTitleEditingChange?: (editing: boolean) => void
}

export function WorktreeCardHoverIdentityHeader({
  branchName,
  workspaceTitle,
  identityOrder,
  workspaceTitleRenameDisabled,
  onRenameWorkspaceTitle,
  onWorkspaceTitleEditingChange
}: WorktreeCardHoverIdentityHeaderProps): React.JSX.Element | null {
  const branchIdentity = branchName ? (
    <div
      className={cn(
        // Why: the hover panel is where users read full git identity; wrap instead
        // of truncating so long branch names stay readable like issue titles below.
        'break-words font-mono text-[11px] leading-snug text-muted-foreground',
        identityOrder === 'workspace-first' && 'mt-1'
      )}
    >
      {branchName}
    </div>
  ) : null
  const workspaceIdentity =
    workspaceTitle && workspaceTitle !== branchName ? (
      onRenameWorkspaceTitle ? (
        <WorktreeTitleInlineRename
          displayName={workspaceTitle}
          disabled={workspaceTitleRenameDisabled}
          editingPresentation="field"
          wrapTitle
          className={cn(
            'cursor-text text-[13px] font-semibold leading-snug text-foreground',
            identityOrder === 'branch-first' && 'mt-1'
          )}
          editingClassName={cn(
            '-mx-1.5 w-[calc(100%+0.75rem)] cursor-text text-[13px] leading-snug',
            identityOrder === 'branch-first' && 'mt-1'
          )}
          onEditingChange={onWorkspaceTitleEditingChange}
          onRename={onRenameWorkspaceTitle}
        />
      ) : (
        <div
          className={cn(
            'break-words text-[13px] font-semibold leading-snug text-foreground',
            identityOrder === 'branch-first' && 'mt-1'
          )}
        >
          {workspaceTitle}
        </div>
      )
    ) : null

  if (!branchIdentity && !workspaceIdentity) {
    return null
  }

  return (
    // Why: detail sections keep the left rule; the hover title stays flush so
    // it reads as the panel heading rather than another inset section.
    <div className="min-w-0" data-worktree-hover-identity-header="">
      {identityOrder === 'branch-first' ? branchIdentity : workspaceIdentity}
      {identityOrder === 'branch-first' ? workspaceIdentity : branchIdentity}
    </div>
  )
}
