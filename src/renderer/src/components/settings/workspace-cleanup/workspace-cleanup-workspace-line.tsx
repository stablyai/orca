import { Folder } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { WorkspaceCleanupWorkspaceRef } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

/** A workspace's name and project in one line; spans only, so it can sit inside a row description. */
export function WorkspaceCleanupWorkspaceLine({
  workspace,
  trailing,
  wrap = false,
  className
}: {
  workspace: Pick<WorkspaceCleanupWorkspaceRef, 'displayName' | 'repoName'>
  trailing?: React.ReactNode
  /**
   * Wrap instead of truncating, so a receipt always says which workspace it means. Inside an
   * `@container`, the name takes its own line below `@xl` and shares it with the project above.
   */
  wrap?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex min-w-0 gap-2',
        wrap ? 'flex-wrap items-baseline gap-y-0.5' : 'items-center',
        className
      )}
    >
      <span
        title={wrap ? undefined : workspace.displayName}
        className={cn(
          'min-w-0 text-sm font-medium text-foreground',
          wrap ? 'basis-full [overflow-wrap:anywhere] @xl:basis-auto' : 'truncate'
        )}
      >
        {workspace.displayName}
      </span>
      <span
        className={cn(
          'inline-flex min-w-0 gap-1 text-xs text-muted-foreground',
          wrap ? 'max-w-full items-start' : 'max-w-48 shrink-[4] items-center'
        )}
      >
        <Folder className={cn('size-3 shrink-0', wrap && 'mt-0.5')} aria-hidden="true" />
        <span
          title={wrap ? undefined : workspace.repoName}
          className={wrap ? 'min-w-0 [overflow-wrap:anywhere]' : 'truncate'}
        >
          {workspace.repoName}
        </span>
      </span>
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
