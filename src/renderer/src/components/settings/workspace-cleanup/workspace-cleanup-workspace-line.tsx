import { Folder } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { WorkspaceCleanupWorkspaceRef } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

/** A workspace's name and project in one line; spans only, so it can sit inside a row description. */
export function WorkspaceCleanupWorkspaceLine({
  workspace,
  trailing,
  className
}: {
  workspace: Pick<WorkspaceCleanupWorkspaceRef, 'displayName' | 'repoName'>
  trailing?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {workspace.displayName}
      </span>
      <span className="inline-flex min-w-0 max-w-48 shrink-[4] items-center gap-1 text-xs text-muted-foreground">
        <Folder className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{workspace.repoName}</span>
      </span>
      {trailing ? (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {trailing}
        </span>
      ) : null}
    </span>
  )
}
