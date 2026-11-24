import { Folder } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { WorkspaceCleanupWorkspaceRef } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

/** A workspace's name and project in one line; spans only, so it can sit inside a row description. */
export function WorkspaceCleanupWorkspaceLine({
  workspace,
  trailing,
  className,
  hideProject = false,
  detail
}: {
  workspace: Pick<WorkspaceCleanupWorkspaceRef, 'displayName' | 'repoName'>
  hideProject?: boolean
  /** Tells apart rows whose name and project match, such as a branch or path. */
  detail?: string
  trailing?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      {/* With a path to give way, the name and project keep their width (up to a cap). */}
      <span
        className={cn(
          'truncate text-sm font-medium text-foreground',
          detail ? 'max-w-[45%] shrink-0' : 'min-w-0'
        )}
      >
        {workspace.displayName}
      </span>
      {hideProject ? null : (
        <span
          className={cn(
            'inline-flex min-w-0 max-w-48 items-center gap-1 text-xs text-muted-foreground',
            detail ? 'shrink-0' : 'shrink-[4]'
          )}
        >
          <Folder className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{workspace.repoName}</span>
        </span>
      )}
      {detail ? (
        // Shown after the project, as it is read. A path differs at its end, so it gives up its start.
        <span
          title={detail}
          className="min-w-0 truncate text-xs text-muted-foreground [direction:rtl]"
        >
          <bdi dir="ltr">{detail}</bdi>
        </span>
      ) : null}
      {trailing ? (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </span>
  )
}

/** One key per workspace across hosts; a bare id can repeat on two hosts. */
export function workspaceCleanupRowKey(
  row: Pick<WorkspaceCleanupWorkspaceRef, 'executionHostId' | 'worktreeId'>
): string {
  return `${row.executionHostId ?? ''}:${row.worktreeId}`
}
